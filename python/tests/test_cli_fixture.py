"""The shared CLI fixture, run against this implementation.

``fixtures/cross-language/cli.json`` is the command line's contract, and the other two
implementations run the same file. Tests written separately for each language can agree with
themselves and still disagree with each other; this is the only kind that cannot.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import zipfile
from pathlib import Path

import pytest

from tdcv2.cli.init import run_init
from tdcv2.cli.main import main
from tdcv2.cli.pack import run_pack

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "cross-language" / "cli.json"


def load() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


DOCUMENT = load()

#: Cases this implementation is expected to pass. A case marked `only` names the implementations
#: that support the feature; `gaps` in the fixture says what closing it would take.
CASES = [c for c in DOCUMENT["cases"] if "python" in c.get("only", ["python"])]
SKIPPED = [c for c in DOCUMENT["cases"] if "python" not in c.get("only", ["python"])]


def build_registry(root: Path) -> str:
    """The demo registry every implementation's runner builds, byte for byte the same."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("demo/packs/demo/person/lastName.txt", "Ivanov\nPetrov\n")
    data = buffer.getvalue()

    (root / "bundles").mkdir(parents=True, exist_ok=True)
    (root / "bundles" / "demo.zip").write_bytes(data)
    (root / "index.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "bundles": [
                    {
                        "id": "demo",
                        "name": "Demo pack",
                        "description": "two surnames",
                        "file": "bundles/demo.zip",
                        "bytes": len(data),
                        "sha256": hashlib.sha256(data).hexdigest(),
                        "locale": "demo",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    # A second, deliberately broken registry beside the honest one: the same archive, advertised
    # at a size it does not have. It lives under its own path so the honest catalogue — which
    # cases assert byte for byte — keeps listing exactly one bundle.
    (root / "broken" / "bundles").mkdir(parents=True, exist_ok=True)
    (root / "broken" / "bundles" / "demo.zip").write_bytes(data)
    (root / "broken" / "index.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "bundles": [
                    {
                        "id": "demo",
                        "name": "Demo pack",
                        "description": "two surnames",
                        "file": "bundles/demo.zip",
                        "bytes": len(data) + 999,
                        "sha256": hashlib.sha256(data).hexdigest(),
                        "locale": "demo",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return root.as_uri()


def resolve(text: str, directory: Path, registry: str | None) -> str:
    out = text.replace("{dir}", str(directory))
    return out if registry is None else out.replace("{registry}", registry)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_case(case: dict, tmp_path: Path, capsys) -> None:
    registry = build_registry(tmp_path / "registry") if case.get("registry") else None

    for name, contents in case.get("files", {}).items():
        # A leading @ names one of the shared configs, so a config used by three cases is written
        # once and cannot drift between them.
        body = DOCUMENT["configs"][contents[1:]] if contents.startswith("@") else contents
        target = tmp_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")

    argv = [resolve(a, tmp_path, registry) for a in case["argv"]]

    command = case.get("command", "main")
    # `init` and `pack` act on a working directory rather than on a named file, so the fixture
    # hands them the temp directory instead of chdir-ing the whole test process into it.
    if command == "init":
        code = run_init(argv, tmp_path)
    elif command == "pack":
        code = run_pack(argv, tmp_path)
    else:
        code = main(argv)

    captured = capsys.readouterr()
    assert code == case["exit"], f"exit code; stderr was:\n{captured.err}"

    if "stdout" in case:
        assert captured.out == case["stdout"]
    for fragment in case.get("stdoutContains", []):
        assert fragment in captured.out
    if "stdoutMatches" in case:
        assert re.search(case["stdoutMatches"], captured.out), captured.out
    for fragment in case.get("stderrContains", []):
        assert resolve(fragment, tmp_path, registry) in captured.err, captured.err

    for name, contents in case.get("wrote", {}).items():
        assert (tmp_path / name).read_text(encoding="utf-8") == contents
    for name, fragments in case.get("wroteContains", {}).items():
        written = (tmp_path / name).read_text(encoding="utf-8")
        for fragment in fragments:
            assert fragment in written, written


def test_the_fixture_is_not_empty() -> None:
    """A runner that silently found nothing would pass every implementation."""
    assert len(CASES) >= 25
    names = [c["name"] for c in DOCUMENT["cases"]]
    assert len(set(names)) == len(names), "case names must be unique"


def test_nothing_is_skipped() -> None:
    """Every case runs here. A skip would have to be explained in `gaps` first."""
    assert SKIPPED == [], [c["name"] for c in SKIPPED]


def test_every_config_reference_resolves() -> None:
    for case in CASES:
        for contents in case.get("files", {}).values():
            if contents.startswith("@"):
                assert contents[1:] in DOCUMENT["configs"], contents


def test_the_working_directory_is_not_disturbed(tmp_path: Path) -> None:
    """`init` and `pack` take a directory rather than changing the process's own."""
    before = os.getcwd()
    run_init(["--yes"], tmp_path)
    assert os.getcwd() == before
