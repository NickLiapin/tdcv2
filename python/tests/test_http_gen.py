"""``<gen type="http">`` against a service that really runs.

A stub would prove the client imports. Only a socket proves it speaks the contract: the count
header, the body of inputs, the line-per-value reply, and each failure the policy has an opinion
about.

Every other implementation had this — TypeScript in seven files, Rust in ``http_gen.rs``, C# in
``HttpGenTest.cs``, Java in ``HttpGenTest.java``. Python had only the signature vectors, so 92 of
this module's 143 statements had never run: the request itself, the headers that carry the
contract, the failure policy, and ``resolve_secret``.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from tdcv2.generators.http import (
    Request,
    SecretError,
    ServiceError,
    contract_headers,
    fetch,
    parse_on_error,
    parse_timeout,
    resolve_secret,
    seed_for,
)


class _Service:
    """A real HTTP server on a real port, answering however the test tells it to."""

    def __init__(self, reply):
        self.seen: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # the name is BaseHTTPRequestHandler's, not a choice
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length).decode("utf-8")
                # Lower-cased on the way in, because header NAMES are case-insensitive and the
                # five implementations do not spell them alike: urllib canonicalises
                # `X-TDC-Count` to `X-Tdc-Count` (so does Go), while the other four send the
                # literal. Both are legal, every conformant service handles both, and a test
                # that pinned one spelling would be testing urllib rather than the contract.
                headers = {k.lower(): v for k, v in self.headers.items()}
                outer.seen.append({"body": body, "headers": headers})
                status, text = reply(len(outer.seen), body, dict(self.headers))
                payload = text.encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass  # a quiet suite

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/values"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def service():
    made: list[_Service] = []

    def start(reply):
        s = _Service(reply)
        made.append(s)
        return s

    yield start
    for s in made:
        s.close()


def _lines(n: int, prefix: str = "v") -> str:
    return "\n".join(f"{prefix}{i}" for i in range(n))


def test_asks_once_and_gets_a_line_per_value(service):
    s = service(lambda call, body, headers: (200, _lines(3)))
    assert fetch(Request(src=s.url, count=3)) == ["v0", "v1", "v2"]
    assert len(s.seen) == 1, "one call per batch, not one per value"
    assert s.seen[0]["headers"]["x-tdc-count"] == "3"


def test_a_trailing_newline_is_tolerated_but_a_blank_line_is_a_value(service):
    s = service(lambda call, body, headers: (200, "a\nb\n"))
    assert fetch(Request(src=s.url, count=2)) == ["a", "b"]
    # An empty line is a VALUE, not padding: a service that means "no value here" says so with
    # an empty line, and swallowing it would shift every value after it.
    s2 = service(lambda call, body, headers: (200, "a\n\nc"))
    assert fetch(Request(src=s2.url, count=3)) == ["a", "", "c"]


def test_inputs_travel_up_and_zero_is_not_absent(service):
    s = service(lambda call, body, headers: (200, _lines(2)))
    fetch(Request(src=s.url, count=2, inputs=["one", "two"]))
    assert s.seen[0]["body"] == "one\ntwo"
    assert s.seen[0]["headers"]["x-tdc-input"] == "2"

    # The ambiguity the header exists to close: one empty input makes an empty body, which is
    # exactly what a pure source sends. The count tells the service which it is.
    empty = service(lambda call, body, headers: (200, ""))
    fetch(Request(src=empty.url, count=0, inputs=[""]))
    pure = service(lambda call, body, headers: (200, _lines(1)))
    fetch(Request(src=pure.url, count=1))
    assert "x-tdc-input" not in pure.seen[0]["headers"], "a pure source sends no input count"


def test_a_short_reply_is_a_failure_not_a_shrug(service):
    # Two values for a batch of three would silently shorten the column.
    s = service(lambda call, body, headers: (200, _lines(2)))
    with pytest.raises(ServiceError) as e:
        fetch(Request(src=s.url, count=3))
    assert "2 line(s) for a batch of 3" in str(e.value)


def test_on_error_empty_softens_a_failure_into_blanks(service):
    s = service(lambda call, body, headers: (500, "nope"))
    with pytest.raises(ServiceError):
        fetch(Request(src=s.url, count=3))
    assert fetch(Request(src=s.url, count=3, on_error="empty")) == ["", "", ""]


def test_rate_limiting_is_fatal_under_both_policies(service):
    # "Slow down" and "stream the whole column" cannot be reconciled, and pretending otherwise
    # yields quietly truncated data.
    s = service(lambda call, body, headers: (429, "slow down"))
    for policy in ("fail", "empty"):
        with pytest.raises(ServiceError) as e:
            fetch(Request(src=s.url, count=2, on_error=policy))
        assert "429" in str(e.value)


def test_a_service_that_cannot_be_reached(service):
    # Nothing is listening on this port; the policy still decides what happens.
    dead = "http://127.0.0.1:9/values"
    with pytest.raises(ServiceError):
        fetch(Request(src=dead, count=2))
    assert fetch(Request(src=dead, count=2, on_error="empty")) == ["", ""]


def test_a_batch_of_nothing_never_leaves_the_process(service):
    s = service(lambda call, body, headers: (200, ""))
    assert fetch(Request(src=s.url, count=0)) == []
    assert s.seen == [], "count=0 must not become a request"


def test_a_signed_request_carries_a_signature_and_never_the_secret(service):
    s = service(lambda call, body, headers: (200, _lines(1)))
    fetch(Request(src=s.url, count=1, seed="abc", secret="k7Fm2p", now_ms=1_786_000_000_000))
    headers = s.seen[0]["headers"]
    assert headers["x-tdc-timestamp"] == "1786000000"
    assert len(headers["x-tdc-signature"]) == 64
    assert "k7Fm2p" not in json.dumps(headers), "the secret itself never goes on the wire"


def test_the_headers_are_the_contract():
    signed = contract_headers(
        Request(src="x", count=4, seed="s1", secret="k", now_ms=1_786_000_000_000), "body"
    )
    assert signed["X-TDC-Count"] == "4"
    assert signed["X-TDC-Seed"] == "s1"
    # Measured against the other four in http-vectors.json; this only pins that it is CARRIED.
    assert len(signed["X-TDC-Signature"]) == 64
    plain = contract_headers(Request(src="x", count=1), "")
    assert "X-TDC-Seed" not in plain
    assert "X-TDC-Signature" not in plain


def test_two_sequences_on_one_service_get_different_seeds():
    # Or a service that generates from the header hands back two identical columns.
    assert seed_for("run", "A") != seed_for("run", "B")
    assert seed_for("run", "A") == seed_for("run", "A")
    assert len(seed_for("run", "A")) == 8


def test_on_error_and_timeout_are_read_the_way_the_page_says():
    assert parse_on_error(None) == "fail"
    assert parse_on_error("  EMPTY ") == "empty"
    with pytest.raises(ValueError, match="on_error"):
        parse_on_error("maybe")

    # The attribute is SECONDS. Read as milliseconds, the documented default written out
    # (timeout="30") gave up after 30ms while the same file waited 30s everywhere else.
    assert parse_timeout("30") == 30_000
    assert parse_timeout("0.5") == 500
    assert parse_timeout(None) == parse_timeout("") == parse_timeout("0")


def test_where_a_secret_may_live(tmp_path: Path):
    assert resolve_secret("  plain  ", ".", {}) == "plain"
    assert resolve_secret("env:TOKEN", ".", {"TOKEN": " abc "}) == "abc"
    (tmp_path / "api.key").write_text("s3cr3t\n", encoding="utf-8")
    assert resolve_secret("file:api.key", str(tmp_path), {}) == "s3cr3t"

    # Empty is refused wherever it came from: signing with nothing produces a signature every
    # caller could forge, which is worse than not signing at all.
    for spec in ("", "   ", "env:", "file:"):
        with pytest.raises(SecretError):
            resolve_secret(spec, str(tmp_path), {})
    with pytest.raises(SecretError):
        resolve_secret("env:TDC_DEFINITELY_UNSET", str(tmp_path), {})
    with pytest.raises(SecretError):
        resolve_secret("file:absent.key", str(tmp_path), {})
