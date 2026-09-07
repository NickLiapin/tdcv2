"""``_pack.json`` — who wrote a folder of packs, under what licence, at what version.

The pack format is otherwise all content and no provenance: a folder of ``.txt`` lists and
``.tdc`` generators says what it produces and nothing about where it came from. That is fine
while the only packs are the bundled ones, and stops being fine the moment somebody downloads
a folder from a colleague, a registry or a company share and has to answer "may we ship data
built from this?".

Everything here is OPTIONAL and nothing here reaches the generated data. A manifest cannot
change a single value: it describes the folder it sits in, and ``tdcv2 pack info`` is what
reads it back. A run never mentions it — the same seed gives the same bytes whether it parses
or not, so halting a generation over it would punish the run for something it does not
depend on.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass

FILENAME = "_pack.json"

FIELDS = ("name", "version", "license", "author", "homepage", "description")
"""The fields read back, in the order ``pack info`` prints them."""


@dataclass(frozen=True, slots=True)
class Found:
    """One folder's manifest, and where it was found."""

    folder: str
    manifest: dict[str, str]


@dataclass(frozen=True, slots=True)
class Sweep:
    """What a sweep of the configured folders turned up."""

    found: list[Found]
    broken: list[str]
    """One line per manifest that would not parse, in the order the folders were read."""


def parse(content: str, folder: str) -> dict[str, str] | str:
    """Parse a ``_pack.json``, or return the complaint to raise.

    Unknown keys are kept quietly: a manifest is metadata, and a folder written for a newer
    TDC — or for a company's own tooling beside it — must not stop working here because it
    carries a field this version has no use for. What is refused is a field that IS known and
    holds the wrong kind of thing, because that one was meant for this reader and will not
    arrive.
    """
    try:
        raw = json.loads(content)
    except ValueError as e:
        return (
            f'{FILENAME} in "{folder}" is not valid JSON ({e}); '
            "nothing in this folder is described until it is fixed"
        )
    if not isinstance(raw, dict):
        return f'{FILENAME} in "{folder}" must be a JSON object, e.g. {{"license": "MIT"}}'

    manifest: dict[str, str] = {}
    for field in FIELDS:
        if field not in raw:
            continue
        value = raw[field]
        if not isinstance(value, str):
            kind = "a list" if isinstance(value, list) else type(value).__name__
            return f'{FILENAME} in "{folder}" has "{field}" as {kind}, and it must be text'
        if value.strip():
            manifest[field] = value
    return manifest


def sweep(
    roots: list[str],
    read: Callable[[str], str | None],
    folders: Callable[[str], list[str]],
    join: Callable[[str, str], str],
) -> Sweep:
    """Look for ``_pack.json`` in each root and in each of its top-level folders.

    Two depths rather than a full walk, and deliberately: a manifest describes a FOLDER OF
    PACKS, which is either a data path somebody configured or one locale inside it. Walking
    deeper would invite a manifest per ``.txt`` file, and the question this answers — who
    wrote this data, and under what licence — is not one a single list of city names has its
    own answer to.
    """
    found: list[Found] = []
    broken: list[str] = []
    seen: set[str] = set()

    def visit(folder: str) -> None:
        if folder in seen:  # a root listed twice describes itself once
            return
        seen.add(folder)
        content = read(join(folder, FILENAME))
        if content is None:
            return
        parsed = parse(content, folder)
        if isinstance(parsed, str):
            broken.append(parsed)
        else:
            found.append(Found(folder, parsed))

    for root in roots:
        visit(root)
        for name in folders(root):
            visit(join(root, name))
    return Sweep(found, broken)


def display_folder(folder: str, cwd: str, relative: Callable[[str, str], str]) -> str:
    """How a found folder is printed: relative to where the command was run when it sits
    inside, absolute otherwise.

    A project's own packs live under the project, so the reader sees ``mypacks/en`` rather
    than sixty characters of temp path — and a store somewhere else in the filesystem still
    says where it really is.
    """
    rel = relative(cwd, folder)
    if rel == "":
        return "."
    return folder if rel.startswith("..") else rel
