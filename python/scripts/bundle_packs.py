"""Copy the starter packs into the package, with the index that lets a zip be searched.

Only the starter set ships: the locale-agnostic packs, English, and the USA country pack. The full
catalogue lives in its own repository and is downloaded on demand — it already dwarfs any library
and it keeps growing, so bundling it would make every install pay for data almost no run uses.

The index matters because an installed package may be a zip, where there is nothing to list.
Without it, "does the locale `sv` exist?" would have no answer short of guessing a filename.

    python scripts/bundle_packs.py
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

STARTER = ("common", "en", "countries/usa")

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent.parent / "data" / "packs"
TARGET = HERE.parent / "src" / "tdcv2" / "packs_data"


def main() -> int:
    if not SOURCE.is_dir():
        print(f"no pack source at {SOURCE}", file=sys.stderr)
        return 1

    if TARGET.exists():
        shutil.rmtree(TARGET)
    TARGET.mkdir(parents=True)

    index: list[str] = []
    for file in sorted(SOURCE.rglob("*.txt")):
        relative = file.relative_to(SOURCE).as_posix()
        if not any(relative == s or relative.startswith(f"{s}/") for s in STARTER):
            continue
        destination = TARGET / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, destination)
        index.append(relative)

    (TARGET / "index.txt").write_text("\n".join(index) + "\n", encoding="utf-8")
    print(f"bundled {len(index)} pack files into {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
