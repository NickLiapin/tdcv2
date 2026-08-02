"""Run one config through all three implementations and time them the same way.

The point is not "which language is fastest" in the abstract — it is whether the three ports,
which are held to producing identical bytes, also cost roughly the same to run. Where they do not,
the gap is worth a number rather than a guess.

Fairness rules, all of them deliberate:

* The LIBRARY, single-threaded, in every language. TypeScript's command-line tool spreads a run
  across worker processes and the other two have nothing like it; timing that against them would
  measure a feature rather than a language.
* The same config file, byte for byte, with only ``count`` and ``engine`` substituted.
* The same clock (``now`` pinned), so a date generator cannot drift between runs.
* Wall clock and peak RSS both from ``/usr/bin/time -l``, so no implementation gets to measure
  itself with its own timer.
* Output compared by digest across the three. A speed number for a run that produced different
  data would be worthless, so the check runs first and a mismatch fails the row.

    python3 bench.py --tier short
    python3 bench.py --tier all --repeats 3
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
WORK = Path("/tmp/tdcbench")

# Measured on this config: 100 000 rows produce 7 229 656 bytes, so ~72.3 bytes a row.
BYTES_PER_ROW = 72.3
ONE_GB = 1024 * 1024 * 1024

TIERS = {
    "short": 10_000,
    "medium": 1_000_000,
    "large": round(ONE_GB / BYTES_PER_ROW / 100_000) * 100_000,  # ≈ 1 GB of output
}

LANGUAGES = ("ts", "java", "python")


@dataclass
class Result:
    language: str
    config: str
    tier: str
    rows: int
    engine: int
    ok: bool
    wall: float | None = None
    user: float | None = None
    sys: float | None = None
    peak_rss_mb: float | None = None
    bytes_out: int | None = None
    digest: str | None = None
    note: str = ""


def command(language: str, config: Path, output: Path) -> list[str]:
    if language == "ts":
        return ["node", str(HERE / "runners" / "run.mjs"), str(config), str(output)]
    if language == "java":
        classpath = (REPO / "java" / "build" / "bench-classpath.txt").read_text().strip()
        return [
            "java",
            "-cp",
            f"{classpath}:{HERE / 'runners' / 'java'}",
            "Bench",
            str(config),
            str(output),
        ]
    return [
        str(REPO / "python" / ".venv" / "bin" / "python"),
        str(HERE / "runners" / "run.py"),
        str(config),
        str(output),
    ]


_REAL = re.compile(r"^\s*real\s+([\d.]+)", re.M)
_USER = re.compile(r"^\s*user\s+([\d.]+)", re.M)
_SYS = re.compile(r"^\s*sys\s+([\d.]+)", re.M)
_RSS = re.compile(r"^\s*(\d+)\s+maximum resident set size", re.M)


def measure(language: str, config: Path, output: Path, timeout: int) -> tuple[dict, str]:
    """One run under ``/usr/bin/time -l``. The same stopwatch for all three."""
    output.unlink(missing_ok=True)
    started = time.time()
    try:
        proc = subprocess.run(
            ["/usr/bin/time", "-l", *command(language, config, output)],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {}, f"timed out after {timeout}s"
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout).strip().splitlines()
        return {}, "; ".join(tail[-3:])[:400] or f"exit {proc.returncode}"

    text = proc.stderr
    real = _REAL.search(text)
    return {
        # `time -l` prints "real" only on some shells; the wall clock measured here is the
        # fallback, and it includes process spawn either way.
        "wall": float(real.group(1)) if real else round(time.time() - started, 3),
        "user": float(m.group(1)) if (m := _USER.search(text)) else None,
        "sys": float(m.group(1)) if (m := _SYS.search(text)) else None,
        "peak_rss_mb": (
            round(int(m.group(1)) / 1024 / 1024, 1) if (m := _RSS.search(text)) else None
        ),
    }, ""


def digest_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def build_config(source: Path, rows: int, engine: int) -> Path:
    text = source.read_text().replace("__COUNT__", str(rows)).replace("__ENGINE__", str(engine))
    target = WORK / f"{source.stem}-{rows}-e{engine}.tdc"
    target.write_text(text)
    return target


def run_cell(
    language: str, source: Path, tier: str, rows: int, engine: int, repeats: int, timeout: int
) -> Result:
    config = build_config(source, rows, engine)
    output = WORK / f"{language}-{source.stem}-{tier}-e{engine}.out"
    best: dict | None = None
    note = ""

    for _ in range(repeats):
        stats, problem = measure(language, config, output, timeout)
        if problem:
            return Result(language, source.stem, tier, rows, engine, False, note=problem)
        if best is None or stats["wall"] < best["wall"]:
            best = stats

    assert best is not None
    return Result(
        language,
        source.stem,
        tier,
        rows,
        engine,
        True,
        digest=digest_of(output),
        bytes_out=output.stat().st_size,
        note=note,
        **best,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tier", default="short", choices=[*TIERS, "all"])
    parser.add_argument("--config", default="customers", help="a stem under configs/")
    parser.add_argument("--engines", default="1,2,3")
    parser.add_argument("--languages", default=",".join(LANGUAGES))
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=7200)
    parser.add_argument("--out", default=None, help="where to append the JSON results")
    args = parser.parse_args()

    WORK.mkdir(parents=True, exist_ok=True)
    source = HERE / "configs" / f"{args.config}.tdc"
    tiers = list(TIERS) if args.tier == "all" else [args.tier]
    engines = [int(e) for e in args.engines.split(",")]
    languages = args.languages.split(",")

    results: list[Result] = []
    for tier in tiers:
        rows = TIERS[tier]
        for engine in engines:
            digests: dict[str, str] = {}
            for language in languages:
                print(
                    f"{args.config:10s} {tier:6s} engine {engine}  {language:6s} ",
                    end="",
                    flush=True,
                )
                result = run_cell(
                    language, source, tier, rows, engine, args.repeats, args.timeout
                )
                results.append(result)
                if result.ok:
                    print(
                        f"{result.wall:8.2f}s  {result.peak_rss_mb:8.1f} MB  "
                        f"{(result.bytes_out or 0) / 1024 / 1024:8.1f} MB out"
                    )
                    digests[language] = result.digest or ""
                else:
                    print(f"FAILED — {result.note}")
                # A finished cell's output is worth nothing once its digest is taken, and at this
                # tier it is a gigabyte of it.
                if tier == "large":
                    (WORK / f"{language}-{source.stem}-{tier}-e{engine}.out").unlink(
                        missing_ok=True
                    )
            if len(set(digests.values())) > 1:
                print("  !! the implementations disagreed about the DATA:")
                for language, value in digests.items():
                    print(f"     {language:8s} {value[:16]}")
                for result in results:
                    if result.tier == tier and result.engine == engine:
                        result.ok = False
                        result.note = "digest mismatch across languages"

    target = Path(args.out) if args.out else HERE / "results" / f"{args.config}-{args.tier}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps([asdict(r) for r in results], indent=1) + "\n")
    print(f"\nwrote {target}")
    return 0 if all(r.ok for r in results) else 1


if __name__ == "__main__":
    if not shutil.which("/usr/bin/time"):
        print("/usr/bin/time is required", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main())
