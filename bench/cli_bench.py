"""Time the five PUBLISHED command lines on one machine, the same way.

The sibling harness (``bench.py``) times the library, single-threaded, which answers "do the
five implementations cost about the same to run". This one answers a different question, the one
a reader of the documentation actually has: *I installed tdcv2 — how long will my run take, and
how much memory will it want?* So it drives the command line each registry hands out, not the
checkout.

Fairness rules, all deliberate:

* The binaries come from the REGISTRIES, installed into throwaway directories. Nothing here
  reads this repository, which is also what makes the numbers reproducible by a stranger.
* The same config file, byte for byte, with only ``count`` and ``engine`` substituted. The engine
  is chosen IN THE CONFIG rather than on the command line, so every implementation is asked in
  the one way all five certainly understand.
* ``--now`` pinned, so a date generator cannot drift between runs, and ``--jobs 1`` where it is
  accepted: TypeScript is the only one that spreads a run across workers, and timing that
  against four single-threaded implementations would measure a feature rather than an engine.
* Wall clock and peak RSS both from ``/usr/bin/time -l``, so no implementation gets to measure
  itself with its own timer.
* Every output is hashed, and the hashes must agree across all five for a given tier. A speed
  number for a run that produced different data is worthless, so a mismatch fails the row rather
  than being reported.

    python3 cli_bench.py --tier small
    python3 cli_bench.py --tier all --repeats 3
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
INSTALLS = Path(
    "/private/tmp/claude-501/-Users-nicklyapin-IdeaProjects-tdc/"
    "bc27dbf1-1c33-44d7-b2b6-62e1cf666f4d/scratchpad/e2e"
)
WORK = Path("/tmp/tdc-cli-bench")

#: The clock every run reads, so `date` cannot drift between them.
NOW = "2026-01-15T12:00:00"

TIERS = {"small": 10_000, "medium": 200_000, "large": 2_000_000}

#: Which engines each config is worth asking, and why the sets differ.
#:
#: `customers` is an ordinary config: engine 1 holds whole columns in memory, engine 2 resolves a
#: row at a time. Engine 3 is absent because it would do exactly what engine 2 does here and the
#: router would send it back — a row measuring a redirect is not a measurement.
#:
#: `uniq` asks for combinations that repeat nowhere in the run, which is the constraint engine 3
#: exists for. Engine 2 is absent because it REFUSES this config outright — a whole-column
#: rearrangement is not answerable one row at a time — and that refusal is a documented behaviour
#: rather than a gap.
ENGINE_SETS = {"customers": (1, 2), "uniq": (1, 3)}

#: How each published command line is invoked. The command comes from the registry install; the
#: argument shape is the only thing that differs between them, which is itself worth showing.
COMMANDS = {
    "npm": [str(INSTALLS / "npm/node_modules/.bin/tdcv2")],
    "pypi": [str(INSTALLS / "pypi/.venv/bin/tdcv2")],
    "crates.io": [str(INSTALLS / "cargo/inst/bin/tdcv2")],
    "nuget": [str(INSTALLS / "nuget/tools/tdcv2")],
    "maven": ["java", "-jar", str(INSTALLS / "maven/tdcv2-0.1.4-cli.jar")],
}

#: `--jobs` exists in every help text, but only TypeScript acts on it. Passing it everywhere keeps
#: the command lines identical; pinning it to 1 is what makes the comparison a comparison.
COMMON_FLAGS = ["--now", NOW, "--jobs", "1"]


@dataclass(frozen=True)
class Row:
    config: str
    implementation: str
    tier: str
    rows: int
    engine: int
    seconds: float
    peak_rss_mb: float
    output_bytes: int
    digest: str
    #: Why this row has no numbers, when it has none. A run that dies for want of memory is the
    #: most interesting result on the page, so it is recorded rather than allowed to end the tier.
    failed: str = ""


def config_for(name: str, rows: int, engine: int) -> Path:
    body = (HERE / "configs" / f"{name}.tdc").read_text()
    body = body.replace("__COUNT__", str(rows)).replace("__ENGINE__", str(engine))
    path = WORK / f"{name}-{rows}-e{engine}.tdc"
    path.write_text(body, encoding="utf-8")
    return path


def measure(command: list[str], config: Path, out: Path) -> tuple[float, float]:
    """Wall seconds and peak RSS in MB, both read from /usr/bin/time -l."""
    proc = subprocess.run(
        ["/usr/bin/time", "-l", *command, str(config), "-o", str(out), *COMMON_FLAGS],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"{command[0]} exited {proc.returncode}:\n{proc.stderr[-2000:]}")

    wall = re.search(r"([\d.]+)\s+real", proc.stderr)
    rss = re.search(r"(\d+)\s+maximum resident set size", proc.stderr)
    if not wall or not rss:
        raise RuntimeError(f"could not read the timing out of:\n{proc.stderr[-2000:]}")
    return float(wall.group(1)), int(rss.group(1)) / 1024 / 1024


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def run(name: str, tier: str, repeats: int) -> list[Row]:
    rows_wanted = TIERS[tier]
    results: list[Row] = []
    for engine in ENGINE_SETS[name]:
        config = config_for(name, rows_wanted, engine)
        for impl, command in COMMANDS.items():
            out = WORK / f"{name}-{impl}-{tier}-e{engine}.csv"
            best: tuple[float, float] | None = None
            failure = ""
            for _ in range(repeats):
                try:
                    seconds, rss = measure(command, config, out)
                except RuntimeError as e:
                    failure = str(e).splitlines()[0][:200]
                    break
                # The fastest of N: a slower run measured the machine's other work, not the engine.
                if best is None or seconds < best[0]:
                    best = (seconds, rss)

            if best is None:
                results.append(
                    Row(
                        name, impl, tier, rows_wanted, engine, 0.0, 0.0, 0, "",
                        failure or "no result",
                    )
                )
                print(f"  {impl:<10} e{engine}  FAILED — {results[-1].failed}", flush=True)
                continue

            results.append(
                Row(
                    config=name,
                    implementation=impl,
                    tier=tier,
                    rows=rows_wanted,
                    engine=engine,
                    seconds=round(best[0], 3),
                    peak_rss_mb=round(best[1], 1),
                    output_bytes=out.stat().st_size,
                    digest=digest(out),
                )
            )
            print(
                f"  {impl:<10} e{engine}  {best[0]:7.2f}s  {best[1]:8.1f} MB  {results[-1].digest}",
                flush=True,
            )
    return results


def check_agreement(results: list[Row]) -> None:
    """Every implementation must have produced the same bytes, or the timings mean nothing."""
    by_tier: dict[tuple[str, str, int], set[str]] = {}
    for r in results:
        if r.failed:
            continue
        by_tier.setdefault((r.config, r.tier, r.engine), set()).add(r.digest)
    for (config, tier, engine), digests in by_tier.items():
        if len(digests) != 1:
            raise SystemExit(
                f"{config} {tier} engine {engine}: implementations disagree — {sorted(digests)}"
            )
    print("\nevery implementation produced identical bytes, on every engine it ran")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tier", default="small", choices=[*TIERS, "all"])
    parser.add_argument("--config", default="customers", choices=[*ENGINE_SETS])
    parser.add_argument("--repeats", type=int, default=1)
    args = parser.parse_args()

    WORK.mkdir(parents=True, exist_ok=True)
    tiers = list(TIERS) if args.tier == "all" else [args.tier]

    results: list[Row] = []
    for tier in tiers:
        print(f"\n=== {args.config} {tier}: {TIERS[tier]:,} rows".replace(",", " "), flush=True)
        results.extend(run(args.config, tier, args.repeats))

    check_agreement(results)
    out = HERE / "results" / f"cli-{args.config}-{'-'.join(tiers)}.json"
    out.write_text(json.dumps([asdict(r) for r in results], indent=2) + "\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
