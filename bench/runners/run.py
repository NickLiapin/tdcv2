"""The Python runner: config in, file out, nothing else.

    python run.py <config> <output>
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python" / "src"))

from tdcv2 import TDC  # noqa: E402

config, output = sys.argv[1], sys.argv[2]
TDC(config, now=1776945600000).write_file(output)
