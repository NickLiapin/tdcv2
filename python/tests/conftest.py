"""The starter packs, generated on demand so a fresh clone can run the tests.

They are not committed: the packs live once, under ``data/packs``, and a second copy inside the
package would drift from it. The build generates them; so does this, for anyone running pytest
straight after a clone.
"""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BUNDLED = REPO / "python" / "src" / "tdcv2" / "packs_data" / "index.txt"
SCRIPT = REPO / "python" / "scripts" / "bundle_packs.py"


def pytest_configure() -> None:
    if BUNDLED.is_file() or not (REPO / "data" / "packs").is_dir():
        return
    argv = sys.argv
    sys.argv = [str(SCRIPT)]
    try:
        runpy.run_path(str(SCRIPT), run_name="__main__")
    except SystemExit:
        pass
    finally:
        sys.argv = argv
