"""The measured JSON turned into tables a person can read.

    python3 report.py results/*.json > results/REPORT.md
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

LANGUAGES = ("ts", "java", "python")
LABELS = {"ts": "TypeScript", "java": "Java", "python": "Python"}
TIER_ORDER = ("short", "medium", "large")
ENGINE_NAMES = {1: "1 — in memory", 2: "2 — streaming", 3: "3 — exact on disk"}


def load(paths: list[str]) -> list[dict]:
    out = []
    for path in paths:
        out.extend(json.loads(Path(path).read_text()))
    return out


def cell(rows: list[dict], config: str, tier: str, engine: int, language: str) -> dict | None:
    for row in rows:
        if (
            row["config"] == config
            and row["tier"] == tier
            and row["engine"] == engine
            and row["language"] == language
        ):
            return row
    return None


def seconds(value: float) -> str:
    if value < 60:
        return f"{value:.2f} s"
    return f"{int(value // 60)} m {value % 60:04.1f} s"


def table(rows: list[dict], config: str) -> str:
    tiers = [t for t in TIER_ORDER if any(r["tier"] == t and r["config"] == config for r in rows)]
    engines = sorted({r["engine"] for r in rows if r["config"] == config})
    out: list[str] = []

    for tier in tiers:
        sample = next(r for r in rows if r["tier"] == tier and r["config"] == config)
        megabytes = (sample.get("bytes_out") or 0) / 1024 / 1024
        out.append(f"\n### {tier} — {sample['rows']:,} rows".replace(",", " "))
        if megabytes:
            out.append(f"\nOutput {megabytes:,.1f} MB.\n".replace(",", " "))
        out.append("| Engine | " + " | ".join(LABELS[x] for x in LANGUAGES) + " | vs fastest |")
        out.append("| --- | ---: | ---: | ---: | :--- |")

        for engine in engines:
            cells = {x: cell(rows, config, tier, engine, x) for x in LANGUAGES}
            if not any(cells.values()):
                continue
            times = {x: c["wall"] for x, c in cells.items() if c and c["ok"] and c["wall"]}
            best = min(times.values()) if times else None
            columns = []
            for language in LANGUAGES:
                found = cells[language]
                if found is None:
                    columns.append("—")
                elif not found["ok"]:
                    columns.append(f"_{found['note'][:40]}_")
                else:
                    columns.append(
                        f"{seconds(found['wall'])}<br><sub>{found['peak_rss_mb']:,.0f} MB</sub>".replace(
                            ",", " "
                        )
                    )
            ratios = (
                ", ".join(f"{LABELS[x][:2]} ×{times[x] / best:.1f}" for x in LANGUAGES if x in times)
                if best
                else ""
            )
            out.append(f"| {ENGINE_NAMES[engine]} | " + " | ".join(columns) + f" | {ratios} |")
    return "\n".join(out)


def main(paths: list[str]) -> int:
    rows = load(paths)
    configs = sorted({r["config"] for r in rows})
    print("Wall clock is the best of the repeats; the small figure under it is peak RSS.")
    for config in configs:
        print(f"\n## `{config}.tdc`")
        print(table(rows, config))
    failures = [r for r in rows if not r["ok"]]
    if failures:
        print("\n## What did not run\n")
        for row in failures:
            print(f"- {LABELS[row['language']]}, {row['tier']}, engine {row['engine']}: {row['note']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
