"""One shard of a parallel run, as its own process.

Run as ``python -m tdcv2.engine._shard <job.json> <start> <stop> <target>``. It exists as a module
rather than as a function handed to ``multiprocessing`` because of what ``spawn`` does to get a
worker going: it re-imports the parent's ``__main__``. For a caller whose script says

    TDC("users.tdc").write_file("out.csv", workers="auto")

at module level — which is how anyone would first write it — that re-import runs the same line
again in every worker, and each of those spawns its own. The usual answer is to tell users to guard
their script with ``if __name__ == "__main__":``, but a library that fork-bombs the machine when
they forget has chosen the wrong default. Launching a named module instead means nothing of the
caller's is ever re-executed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main(argv: list[str]) -> int:
    if len(argv) not in (4, 5):
        print("usage: _shard <job.json> <start> <stop> <target> [progress-file]", file=sys.stderr)
        return 2

    job = json.loads(Path(argv[0]).read_text(encoding="utf-8"))
    start, stop, target = int(argv[1]), int(argv[2]), argv[3]
    progress_file = Path(argv[4]) if len(argv) == 5 else None

    options = dict(job["options"])
    for key in ("packs_dir", "base_dir"):
        if options.get(key) is not None:
            options[key] = Path(options[key])
    if options.get("data_paths") is not None:
        options["data_paths"] = [Path(p) for p in options["data_paths"]]

    from ..tdc import TDC

    # How a shard tells the parent where it has got to. A worker is its own PROCESS here, so a
    # callback cannot reach across; what can is a file the parent already knows the name of. It
    # holds one number — the rows THIS shard has written — and the parent adds them up. Replaced
    # atomically, so a parent reading mid-write gets the previous count rather than half a number.
    def report(phase: str, done: int, total: int) -> None:
        if phase != "render" or progress_file is None:
            return
        tmp = progress_file.with_name(progress_file.name + ".tmp")
        tmp.write_text(str(done), encoding="utf-8")
        tmp.replace(progress_file)

    # Back into row numbers: JSON keys are strings, and the engine addresses rows by int.
    uniq_plan = {
        label: {int(row): values for row, values in moved.items()}
        for label, moved in job.get("uniq_plan", {}).items()
    }

    run = TDC(
        job["config_file"],
        on_progress=report if progress_file is not None else None,
        uniq_plan=uniq_plan or None,
        **options,
    )._run()
    with open(target, "w", encoding="utf-8") as out:
        run.write_rows(out.write, start, stop)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
