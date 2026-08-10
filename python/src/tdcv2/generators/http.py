"""``<gen type="http" src="...">`` — values from a service the user runs.

A pack cannot know every vocabulary. When the values have to come from somewhere else entirely —
a company's own service, a model, a licensed dataset — this is the seam: TDC POSTs a batch and
reads back one value per line.

Batch, never per row. One call carries a whole chunk, which is what keeps a billion rows to a
thousand requests rather than a billion. The module knows the wire contract and the error model
and nothing about sequences; the caller wraps a failure with the sequence name and a TDC code.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from enum import Enum

DEFAULT_TIMEOUT_MS = 30_000


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

    secret: str | None = None
    """The already-resolved ``secret=``, if the config carries one.

    Present means the request is SIGNED: ``X-TDC-Timestamp`` and ``X-TDC-Signature`` travel with
    it and the service can tell the generator from anyone else who can reach the port. The secret
    itself never goes on the wire. Resolution is the caller's job — see ``resolve_secret``.
    """

    now_ms: int | None = None
    """Wall-clock milliseconds stamped into the signature.

    The REAL clock, not the run's pinned ``now``: it exists so a service can refuse a request
    replayed tomorrow, and a config pinned to last year would be refused by every service that
    checks. Injectable so a test can pin it.
    """


def sign_request(secret: str, timestamp: str, seed: str, count: int, body: str) -> str:
    """``hex(HMAC-SHA256(secret, timestamp \n seed \n count \n body))``.

    Everything that decides what comes back is inside: change the body, the count, the seed or
    the minute, and the signature no longer matches. The secret is the key, so it is never sent.
    """
    return hmac.new(
        secret.encode("utf-8"),
        f"{timestamp}\n{seed}\n{count}\n{body}".encode(),
        hashlib.sha256,
    ).hexdigest()


def contract_headers(request: Request, body: str) -> dict[str, str]:
    """The headers that say what this request IS, beyond its body.

    ``X-TDC-Input`` is the one that closes a real ambiguity: ``in=`` naming a column of one empty
    value produced an empty body, which is exactly what a pure source sends, and the service could
    not tell "process this empty value" from "invent one". It carries the number of input lines, so
    zero-versus-absent is the whole answer, and a service that ignores it behaves as it always did.
    """
    headers = {"Content-Type": "text/plain", "X-TDC-Count": str(request.count)}
    if request.seed is not None:
        headers["X-TDC-Seed"] = request.seed
    if request.inputs is not None:
        headers["X-TDC-Input"] = str(len(request.inputs))
    if request.secret:
        now_ms = request.now_ms if request.now_ms is not None else int(time.time() * 1000)
        timestamp = str(now_ms // 1000)
        headers["X-TDC-Timestamp"] = timestamp
        headers["X-TDC-Signature"] = sign_request(
            request.secret, timestamp, request.seed or "", request.count, body
        )
    return headers


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
    headers = contract_headers(request, body)

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
    """`timeout="30"` -> 30_000 ms.

    The attribute is SECONDS, as it is in the other four implementations and as
    the generator's page says. This read it as milliseconds, so the documented
    default written out -- timeout="30" -- gave up after 30ms, in 0.185s, while
    the same file waited 30s everywhere else. The validator (TDC069) refuses a
    value that is not a positive number before the run, so this only has to
    handle what got through.
    """
    if value is None or not value.strip():
        return DEFAULT_TIMEOUT_MS
    try:
        seconds = float(value.strip())
    except ValueError:
        return DEFAULT_TIMEOUT_MS
    return int(seconds * 1000) if seconds > 0 else DEFAULT_TIMEOUT_MS


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


class SecretError(Exception):
    """Why a ``secret=`` could not be turned into bytes. The caller names the sequence."""


def resolve_secret(spec: str, base_dir: str, env: dict[str, str] | None = None) -> str:
    """``secret="…"`` → the bytes to sign with.

    The secret is the one thing in a run that must not travel: it never goes on the wire (only a
    signature derived from it does) and it should not travel into version control either, which is
    what a config does. So the two spellings that keep it out of the file come first, and the
    literal is accepted — with TDC284 saying why it is a poor idea — rather than refused, because
    a service on 127.0.0.1 for an afternoon is a real use.

        secret="env:TDC_HTTP_SECRET"      read from the environment
        secret="file:~/.tdc/service.key"  read from a file, trimmed
        secret="k7Fm2p…"                  the value itself

    An empty secret is refused wherever it came from: signing with nothing produces a signature
    every caller could forge, which is worse than not signing at all.
    """
    environ = os.environ if env is None else env
    trimmed = spec.strip()
    if trimmed.startswith("env:"):
        name = trimmed[4:].strip()
        if not name:
            raise SecretError('secret="env:" names no variable')
        value = environ.get(name)
        if value is None or not value.strip():
            raise SecretError(
                f'secret="env:{name}" — the environment variable is not set, or is empty'
            )
        return value.strip()
    if trimmed.startswith("file:"):
        raw = trimmed[5:].strip()
        if not raw:
            raise SecretError('secret="file:" names no file')
        path = os.path.expanduser(raw)
        if not os.path.isabs(path):
            path = os.path.join(base_dir, path)
        try:
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
        except OSError as e:
            raise SecretError(f'secret="file:{raw}" could not be read ({e})') from e
        # Trimmed because a key file written by a person almost always ends in a newline, and a
        # signature that silently includes it agrees with nothing.
        value = text.strip()
        if not value:
            raise SecretError(f'secret="file:{raw}" is empty')
        return value
    if not trimmed:
        raise SecretError('secret="" is empty')
    return trimmed
