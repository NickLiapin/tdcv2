"""``fixtures/cross-language/http-batches.json``, run against a real local service.

The other four implementations run the same file; between them they hold the batch contract —
what each request carries, where each answer lands, and what a column reading an answer sees — to
one behaviour.
"""

from __future__ import annotations

import json
import threading
import time
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
    if service == "row-repeat":
        return 200, [f"r{1 if offset + i == 3 else offset + i}" for i in range(count)], True
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
        "row-repeat",
    }


# Every engine reads the same batches: the in-memory one a column at a time, the two streaming
# ones a row at a time. None is the router's choice.
_ENGINES = [None, "1", "2", "3"]


@pytest.mark.parametrize("engine_id", _ENGINES, ids=lambda e: f"engine-{e or 'auto'}")
@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["name"])
def test_a_shared_http_case(case: dict, engine_id: str | None) -> None:
    service = _Service(case["service"])
    try:
        text = case["config"].replace("{{SRC}}", service.url)
        parsed = facade.parse(text)
        assert parsed.ok, [str(p) for p in parsed.problems]
        refusals = [d for d in validate(parsed.tree, packs=_PACKS) if d.severity.name == "ERROR"]
        assert not refusals, [d.signature() for d in refusals]
        config = config_builder.build(parsed.tree)
        if engine_id is not None:
            config = config.with_engine(engine_id)
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


def test_every_http_generator_is_found_wherever_it_sits() -> None:
    """The batch sizes a parallel split must fall on, from a switch case and a field alike."""
    from tdcv2.generators import http_column

    text = (
        '<tdc><env count="3" seed="s">'
        '<sequence name="K"><gen type="text" value="x,y"/></sequence>'
        '<switch name="S" on="K"><case is="x"><gen type="http" src="http://127.0.0.1:9/" '
        'batch="4"/></case><default><gen type="text" value="-"/></default></switch>'
        '<sequence name="F"><gen name="a" type="http" src="http://127.0.0.1:9/" batch="6"/>'
        '<gen name="b" type="text" value="z"/></sequence>'
        '<sequence name="P"><gen type="http" src="http://127.0.0.1:9/"/></sequence>'
        "</env><block><line><data>${{S}}</data></line></block></tdc>"
    )
    config = config_builder.build(facade.parse(text).tree)
    assert sorted(http_column.batches_in(config)) == [4, 6, 10_000]


def test_a_worker_reads_ahead_no_further_than_its_own_rows() -> None:
    """A shard writes a range; the batch after its last row belongs to the next shard."""
    from tdcv2 import TDC

    for start, stop, want in ((0, 20, [0, 10]), (20, 40, [20, 30])):
        service = _Service("row")
        try:
            text = (
                '<tdc><env count="40" seed="s">'
                f'<sequence name="Out"><gen type="http" src="{service.url}" batch="10"/></sequence>'
                "</env><block><line><data>${{Out}}</data></line></block></tdc>"
            )
            written: list[str] = []
            TDC(config_string=text, packs_dir=REPO / "data" / "packs")._run().write_rows(
                written.append, start, stop
            )
            assert "".join(written).split("\n")[0] == f"r{start}"
            # A request sent ahead travels on its own thread; give one the time to arrive,
            # since what is checked is that none does.
            time.sleep(0.5)
            assert sorted(r["offset"] for r in service.seen) == want
        finally:
            service.close()
