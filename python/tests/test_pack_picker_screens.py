"""The pack picker's screens, against the shared fixture.

The reference is driven by ``typescript/scripts/picker-screens.ts``, which puts a fake terminal in
front of the real picker and records every line it draws after every key. This does the same here,
and the file it checks against is the same file, so a screen that differs by one space between the
two implementations is a failing test rather than something a user notices.

Three seams and no stubs: the module is re-imported with the run's environment so its ``UNICODE``
and ``COLOUR`` are settled afresh, ``_terminal_size`` is told the run's width and height, and
stdin and stdout are strings. Raw mode switches itself off — it asks ``sys.stdin.isatty()`` first,
and a string is not a terminal.
"""

from __future__ import annotations

import importlib
import io
import json
import sys
from pathlib import Path

import pytest

from tdcv2.cli import pack_picker as picker_module
from tdcv2.packs.registry import Bundle

FIXTURE = (
    Path(__file__).resolve().parents[2] / "fixtures" / "cross-language" / "pack-picker-screens.json"
)
DATA = json.loads(FIXTURE.read_text(encoding="utf-8"))

ESC = "\x1b"
KEY_BYTES = {
    "up": f"{ESC}[A",
    "down": f"{ESC}[B",
    "right": f"{ESC}[C",
    "left": f"{ESC}[D",
    "home": f"{ESC}[1~",
    "end": f"{ESC}[4~",
    "pageup": f"{ESC}[5~",
    "pagedown": f"{ESC}[6~",
    "enter": "\r",
    "space": " ",
    "backspace": "\x7f",
    "escape": ESC,
}

#: Everything the picker's terminal detection reads, and so everything a run has to set.
TERMINAL_ENV = ("TDCV2_ASCII", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR", "TERM")


def _bundles() -> list[Bundle]:
    out = []
    for b in DATA["bundles"]:
        out.append(
            Bundle(
                id=b["id"],
                name=b["name"],
                description=b["description"],
                file=f"{b['id']}.zip",
                bytes=b["bytes"],
                sha256="0" * 64,
                locale=b["locale"],
                country=b["country"],
                regions=list(b["regions"] or []),
                point=tuple(b["point"]) if b["point"] else None,
            )
        )
    return out


def _to_lines(text: str) -> list[str]:
    """The screen as the user sees it — clear, home and cursor commands carry no content."""
    for command in (f"{ESC}[2J", f"{ESC}[H", f"{ESC}[?25l", f"{ESC}[?25h"):
        text = text.replace(command, "")
    return text.removesuffix("\n").split("\n")


class _Capture(io.StringIO):
    """One entry per ``write``, because one write is one screen."""

    def __init__(self) -> None:
        super().__init__()
        self.written: list[str] = []

    def write(self, text: str) -> int:
        self.written.append(text)
        return len(text)


def _play(run: dict, monkeypatch: pytest.MonkeyPatch) -> tuple[list[list[str]], object]:
    terminal = run["terminal"]
    for name in TERMINAL_ENV:
        monkeypatch.delenv(name, raising=False)
    if not terminal["unicode"]:
        monkeypatch.setenv("TDCV2_ASCII", "1")
    else:
        monkeypatch.setenv("LANG", "en_US.UTF-8")
    if terminal["colour"]:
        monkeypatch.setenv("TERM", "xterm-256color")
    else:
        monkeypatch.setenv("NO_COLOR", "1")

    keys = "".join(KEY_BYTES.get(k, k) for k in run["keys"])
    out = _Capture()
    monkeypatch.setattr(sys, "stdin", io.StringIO(keys))
    monkeypatch.setattr(sys, "stdout", out)

    # Colour is settled at import from `sys.stdout.isatty()`, so the swap above has to be in place
    # before the reload and the reload has to happen after the environment is set.
    module = importlib.reload(picker_module)
    monkeypatch.setattr(module, "_terminal_size", lambda: (terminal["columns"], terminal["rows"]))
    if terminal["colour"]:
        monkeypatch.setattr(module, "COLOUR", True)

    decision = module.run_picker(_bundles(), set(run["installed"]))

    # The first write hides the cursor and carries no screen; everything after it is one draw,
    # ending with the clear the picker writes on its way out — which is the empty screen the
    # reference records for the key that left.
    screens = [_to_lines(text) for text in out.written[1:]]
    result = (
        None
        if decision is None
        else {"install": list(decision.install), "remove": list(decision.remove)}
    )
    return screens, result


@pytest.mark.parametrize("run", DATA["runs"], ids=lambda r: r["name"])
def test_draws_what_the_shared_fixture_says(run, monkeypatch):
    screens, result = _play(run, monkeypatch)

    assert len(screens) == len(run["screens"])
    for i, screen in enumerate(screens):
        after = "the opening draw" if i == 0 else f'the key "{run["keys"][i - 1]}"'
        assert "\n".join(screen) == "\n".join(run["screens"][i]), f"after {after}"
    assert result == run["result"]


def teardown_module() -> None:
    """Put the module back the way the rest of the suite expects to find it."""
    importlib.reload(picker_module)
