"""``fixtures/cross-language/http-batches.json``, run against a real local service.

The other four implementations run the same file; between them they hold the batch contract —
what each request carries, where each answer lands, and what a column reading an answer sees — to
one behaviour.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from tdcv2 import engine
from tdcv2.packs import DataPacks
from tdcv2.parser import config_builder, facade
from tdcv2.validator.validate import validate

REPO = Path(__file__).resolve().parents[2]
FIXTURE = json.loads(
    (REPO / "fixtures" / "cross-language" / "http-batches.json").read_text(encoding="utf-8")
)
_PACKS = DataPacks.for_project(REPO)


def _answer(service: str, served: int, offset: int, inputs: list[str], count: int):
    """What the fixture's service answers: (status, lines, echo the offset?)."""
    if service == "fail-second" and served > 1:
        return 500, [], True
    if service in ("upper", "upper-no-echo"):
        return 200, [f"H{line}" for line in inputs], service == "upper"
    if service == "row-no-echo":
        return 200, [f"r{i}" for i in range(count)], False
    # row, and fail-second's first answer
    return 200, [f"r{offset + i}" for i in range(count)], True


class _Service:
    def __init__(self, name: str) -> None:
        self.seen: list[dict] = []
        self.seeds: list[str] = []
        lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # the name is BaseHTTPRequestHandler's, not a choice
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length).decode("utf-8")
                count = int(self.headers.get("X-TDC-Count") or 0)
                offset = int(self.headers.get("X-TDC-Offset") or 0)
                total = self.headers.get("X-TDC-Total")
                declared = self.headers.get("X-TDC-Input")
                inputs = (
                    []
                    if declared is None or declared == "0"
                    else ([""] if body == "" else body.split("\n"))
                )
                with lock:
                    outer.seeds.append(self.headers.get("X-TDC-Seed") or "")
                    outer.seen.append(
                        {
                            "count": count,
                            "offset": offset,
                            "total": None if total is None else int(total),
                            "input": None if declared is None else int(declared),
                        }
                    )
                    served = len(outer.seen)
                status, lines, echo = _answer(name, served, offset, inputs, count)
                payload = "\n".join(lines).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(payload)))
                if echo:
                    self.send_header("X-TDC-Offset", str(offset))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass  # a quiet suite

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/gen"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def test_every_service_the_fixture_names_is_run_here():
    assert set(FIXTURE["services"]) == {
        "upper",
        "row",
        "row-no-echo",
        "upper-no-echo",
        "fail-second",
    }


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["name"])
def test_a_shared_http_case(case: dict) -> None:
    service = _Service(case["service"])
    try:
        text = case["config"].replace("{{SRC}}", service.url)
        parsed = facade.parse(text)
        assert parsed.ok, [str(p) for p in parsed.problems]
        refusals = [d for d in validate(parsed.tree, packs=_PACKS) if d.severity.name == "ERROR"]
        assert not refusals, [d.signature() for d in refusals]
        config = config_builder.build(parsed.tree)
        if "error" in case:
            with pytest.raises(Exception) as caught:
                engine.render(config, _PACKS, 0, None)
            assert case["error"].replace("{{SRC}}", service.url) in str(caught.value)
        else:
            assert engine.render(config, _PACKS, 0, None) == case["output"]
        if "requests" in case:
            assert sorted(service.seen, key=lambda r: r["offset"]) == case["requests"]
        if "seeds" in case:
            assert sorted(service.seeds) == case["seeds"]
    finally:
        service.close()
