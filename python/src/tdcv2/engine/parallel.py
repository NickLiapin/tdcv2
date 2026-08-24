"""One run split across processes.

CPython executes one thread of bytecode at a time, so threads buy nothing here — the work is
arithmetic, not waiting. Processes do, and a TDC run happens to be the easy case for them: the
streaming engine keys every draw by ``seed|stream|index``, so row nine million is a function of its
own number and needs to know nothing about row eight million. A shard can therefore be computed
without any coordination at all, which is the whole reason the seekable generator exists.

Each worker builds its own run from the same config file and writes rows ``[start, stop)`` to its
own file; the parent concatenates them in order. That the pieces join into exactly the bytes one
process would have written is a property of ``StreamEngine.write_rows``, not of luck — the opening
and closing fixtures are tied to the shard that owns row zero and the shard that owns the last row.

Workers are launched as ``python -m tdcv2.engine._shard``, not through ``multiprocessing``. See
that module for why: ``spawn`` re-imports the caller's ``__main__``, which turns an unguarded
``write_file(..., workers="auto")`` into a fork bomb.

Only the streaming engine qualifies. The in-memory engine holds the whole run anyway, so splitting
it would multiply the memory rather than the throughput; the exact engine carries state across rows
that a shard cannot reconstruct on its own. Both fall back to a single process, which is a slower
answer and never a wrong one.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

# Below this, a process costs more to start than its rows cost to generate. A worker's own startup
# — interpreter, config parse, pack load — is a few tenths of a second.
MIN_ROWS_PER_WORKER = 50_000


def default_workers() -> int:
    """One process per core bar one, so the machine stays usable while a run is going."""
    return max(1, (os.cpu_count() or 2) - 1)


def shards(count: int, workers: int) -> list[tuple[int, int]]:
    """Contiguous, gapless row ranges covering ``[0, count)``.

    The remainder goes to the earliest shards one row at a time rather than all onto the last, so
    no worker is a whole batch behind the others at the end.
    """
    if workers < 1:
        raise ValueError("workers must be at least 1")
    base, extra = divmod(count, workers)
    out: list[tuple[int, int]] = []
    start = 0
    for i in range(workers):
        stop = start + base + (1 if i < extra else 0)
        if stop > start:
            out.append((start, stop))
        start = stop
    return out


class ShardError(RuntimeError):
    """A worker failed, with whatever it said before it did."""


def _watch(counters, count: int, on_progress, stop: threading.Event) -> None:
    """Add up what the shards have written, until told the run is over.

    Each shard keeps one number in one file; this reads them all four times a second and reports
    the sum. A file that is missing or half-parsed counts as zero for that round rather than
    stopping the watch: it means a shard has not written yet, which is not an error, and the next
    round will see it.
    """
    while not stop.wait(0.25):
        done = 0
        for counter in counters:
            try:
                done += int(counter.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
        on_progress("render", done, count)


def _plain(value: object) -> object:
    """A `TDC` option as JSON. Only paths need help; everything else already is."""
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, list):
        return [_plain(item) for item in value]
    return value


def write_file(
    config_file: str | Path,
    target: str | Path,
    options: dict,
    workers: int,
    count: int,
    on_progress=None,
    uniq_plan: dict | None = None,
) -> None:
    """Write ``target`` from ``config_file`` using ``workers`` processes.

    ``options`` is forwarded to ``TDC`` verbatim in every worker, so the shards agree about the
    seed, the clock and the engine. Anything a worker cannot be told this way — a config passed as
    a string rather than a file, say — is why the caller checks before getting here.
    """
    target = Path(target)
    work_dir = Path(tempfile.mkdtemp(prefix="tdc-parallel-"))
    try:
        job_file = work_dir / "job.json"
        job_file.write_text(
            json.dumps(
                {
                    "config_file": str(Path(config_file).resolve()),
                    "options": {k: _plain(v) for k, v in options.items()},
                    # Worked out once by the parent. A worker that repeated it would make
                    # splitting the file slower than not splitting it — and the JSON is small,
                    # because only the rows that actually moved are in it.
                    "uniq_plan": {
                        label: {str(row): values for row, values in moved.items()}
                        for label, moved in (uniq_plan or {}).items()
                    },
                }
            ),
            encoding="utf-8",
        )

        # The library may be on the path only because the caller put it there, so pass our own
        # location down rather than assuming an installed package.
        env = dict(os.environ)
        root = str(Path(__file__).resolve().parents[2])
        env["PYTHONPATH"] = root + os.pathsep + env.get("PYTHONPATH", "")

        parts = [work_dir / f"part-{i:05d}" for i in range(len(shards(count, workers)))]
        counters = (
            [work_dir / f"progress-{i:05d}" for i in range(len(parts))] if on_progress else []
        )
        running = [
            subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "tdcv2.engine._shard",
                    str(job_file),
                    str(start),
                    str(stop),
                    str(part),
                    *([str(counters[i])] if counters else []),
                ],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            for i, ((start, stop), part) in enumerate(
                zip(shards(count, workers), parts, strict=True)
            )
        ]

        # A watcher, not a wait. The reading below has to stay exactly as it was — a shard's stderr
        # pipe fills at 64 KB and a parent that polls instead of draining would deadlock the moment
        # one of them said too much. So the counting happens beside it, on its own thread, and the
        # failure handling never learns that anyone is watching.
        watching = threading.Event()
        watcher = None
        if counters:
            watcher = threading.Thread(
                target=_watch, args=(counters, count, on_progress, watching), daemon=True
            )
            watcher.start()

        try:
            failures = []
            for i, process in enumerate(running):
                _, errors = process.communicate()
                if process.returncode != 0:
                    failures.append(
                        f"shard {i}: {(errors or '').strip().splitlines()[-1:] or ['?']}"
                    )
        finally:
            watching.set()
            if watcher is not None:
                watcher.join(timeout=2)
        if failures:
            raise ShardError("parallel run failed — " + "; ".join(failures))

        with target.open("wb") as out:
            for part in parts:
                with part.open("rb") as piece:
                    shutil.copyfileobj(piece, out, length=1 << 20)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
