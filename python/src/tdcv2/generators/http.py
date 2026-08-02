"""``<gen type="http" src="...">`` — values from a service the user runs.

A pack cannot know every vocabulary. When the values have to come from somewhere else entirely —
a company's own service, a model, a licensed dataset — this is the seam: TDC POSTs a batch and
reads back one value per line.

Batch, never per row. One call carries a whole chunk, which is what keeps a billion rows to a
thousand requests rather than a billion. The module knows the wire contract and the error model
and nothing about sequences; the caller wraps a failure with the sequence name and a TDC code.
"""

from __future__ import annotations

import urllib.error
import urllib.request
from dataclasses import dataclass
from enum import Enum

DEFAULT_TIMEOUT_MS = 10_000


# The most of a reply this client will hold; see the read below for why.
_MAX_RESPONSE_BYTES = 64 * 1024 * 1024


class FailureKind(Enum):
    """Why a service call failed. The caller turns this into a diagnostic."""

    STATUS = "status"
    """A non-2xx response that is not 429."""

    RATE_LIMITED = "rate-limited"
    """429 — always fatal, even under ``on_error="empty"``."""

    TIMEOUT = "timeout"
    NETWORK = "network"

    COUNT_MISMATCH = "count-mismatch"
    TOO_LARGE = "too-large"
    """2xx, but not exactly ``count`` lines back."""


class ServiceError(Exception):
    def __init__(
        self, message: str, kind: FailureKind, url: str, status: int | None = None
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.url = url
        self.status = status


@dataclass(frozen=True, slots=True)
class Request:
    src: str
    count: int
    """How many values are wanted — travels as ``X-TDC-Count`` and bounds the reply."""

    inputs: list[str] | None = None
    """One line per input value, in row order. Absent for a pure source."""

    seed: str | None = None
    """Travels as ``X-TDC-Seed``.

    Derived per SEQUENCE, not the raw ``<env>`` seed: two http sequences pointed at one service
    must not receive the same seed, or a service that generates from it would hand back two
    identical columns.
    """

    on_error: str = "fail"
    timeout_ms: int = DEFAULT_TIMEOUT_MS


def seed_for(env_seed: str, sequence_name: str) -> str:
    """The value sent as ``X-TDC-Seed``: eight hex digits from the run's seed and the sequence name.

    Through the same hash the engine keys its own streams with, and matching every other
    implementation to the character — a service written to be reproducible from this header must
    get the same header whichever runtime called it, or the same config produces different data
    depending on the runtime, which is the one thing this project exists to prevent.
    """
    from ..prng.prng import cyrb128

    return format(cyrb128(f"{env_seed}|http|{sequence_name}")[0] & 0xFFFFFFFF, "08x")


def fetch(request: Request) -> list[str]:
    """One batch against the service, resolving to exactly ``count`` strings.

    ``on_error="fail"`` raises; ``"empty"`` returns blanks instead — EXCEPT for 429, which is
    fatal under both, because "slow down" and "stream the whole column" cannot be reconciled and
    pretending otherwise yields quietly truncated data.
    """
    if request.count <= 0:
        return []

    body = "" if request.inputs is None else "\n".join(request.inputs)
    headers = {"Content-Type": "text/plain", "X-TDC-Count": str(request.count)}
    if request.seed is not None:
        headers["X-TDC-Seed"] = request.seed

    # The URL is the config author's own service, named in their own config.
    post = urllib.request.Request(
        request.src, data=body.encode("utf-8"), headers=headers, method="POST"
    )

    try:
        with urllib.request.urlopen(post, timeout=request.timeout_ms / 1000) as response:
            status = response.status
            # Read through a hard cap, not to the end: the wire contract is one
            # value per line for `count` rows — a bounded, known-small answer —
            # so a body past the cap is a misbehaving service, and reading it
            # out would trade an error message for exhausted memory. The same
            # limit lives in the other four implementations.
            raw = response.read(_MAX_RESPONSE_BYTES + 1)
            if len(raw) > _MAX_RESPONSE_BYTES:
                return _fail(
                    request,
                    ServiceError(
                        f"answered with more than {_MAX_RESPONSE_BYTES} bytes"
                        " — not a per-line reply",
                        FailureKind.TOO_LARGE,
                        request.src,
                        status,
                    ),
                )
            text = raw.decode("utf-8")
    except urllib.error.HTTPError as e:
        status = e.code
        if status == 429:
            # Always fatal — the one error on_error cannot soften.
            raise ServiceError(
                "returned 429 (rate limited)", FailureKind.RATE_LIMITED, request.src, 429
            ) from None
        return _fail(
            request, ServiceError(f"returned {status}", FailureKind.STATUS, request.src, status)
        )
    except TimeoutError:
        return _fail(
            request,
            ServiceError(
                f"did not answer within {request.timeout_ms}ms", FailureKind.TIMEOUT, request.src
            ),
        )
    except (urllib.error.URLError, OSError) as e:
        reason = getattr(e, "reason", e)
        if isinstance(reason, TimeoutError):
            return _fail(
                request,
                ServiceError(
                    f"did not answer within {request.timeout_ms}ms",
                    FailureKind.TIMEOUT,
                    request.src,
                ),
            )
        return _fail(
            request,
            ServiceError(f"could not be reached ({reason})", FailureKind.NETWORK, request.src),
        )

    lines = _split_lines(text)
    if len(lines) != request.count:
        return _fail(
            request,
            ServiceError(
                f"returned {len(lines)} line(s) for a batch of {request.count}",
                FailureKind.COUNT_MISMATCH,
                request.src,
                status,
            ),
        )
    return lines


def parse_on_error(value: str | None) -> str:
    if value is None or not value.strip():
        return "fail"
    normalized = value.strip().lower()
    if normalized in ("fail", "empty"):
        return normalized
    raise ValueError(f'http generator: on_error "{value}" must be "fail" or "empty"')


def parse_timeout(value: str | None) -> int:
    if value is None or not value.strip():
        return DEFAULT_TIMEOUT_MS
    try:
        ms = int(value.strip())
    except ValueError:
        raise ValueError(f'http generator: timeout "{value}" must be a positive integer') from None
    if ms <= 0:
        raise ValueError(f'http generator: timeout "{value}" must be a positive integer')
    return ms


def _fail(request: Request, error: ServiceError) -> list[str]:
    """The on_error policy applied to a transport failure."""
    if request.on_error == "empty":
        return [""] * request.count
    raise error


def _split_lines(text: str) -> list[str]:
    """The reply as value lines, tolerating a single trailing newline."""
    if text == "":
        return []
    trimmed = text[:-1] if text.endswith("\n") else text
    return trimmed.split("\n")
