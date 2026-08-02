"""The one thing pyproject.toml alone cannot express: generate the starter packs before building.

The packs are DATA, and they live in this repository once, under ``data/packs``. Committing a
second copy inside the package would guarantee the two drift, so the copy is made at build time
instead — the same thing the Gradle build does for the jar.
"""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

from setuptools import setup
from setuptools.command.build_py import build_py

HERE = Path(__file__).resolve().parent


class BuildWithPacks(build_py):
    def run(self) -> None:
        script = HERE / "scripts" / "bundle_packs.py"
        if script.is_file() and (HERE.parent / "data" / "packs").is_dir():
            sys.argv = [str(script)]
            try:
                runpy.run_path(str(script), run_name="__main__")
            except SystemExit as exit_code:
                if exit_code.code:
                    raise
        super().run()


setup(cmdclass={"build_py": BuildWithPacks})
