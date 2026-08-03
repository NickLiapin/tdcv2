"""Pack loading, the project cascade, and the registry client."""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path

import pytest

from tdcv2.packs import DataPacks, PackError, Registry, project_config, registry, source, store

REPO = Path(__file__).resolve().parents[2]


# ── what the wheel carries ──────────────────────────────────────────────────────────────────


def test_the_starter_set_is_english_common_and_one_country() -> None:
    packs = DataPacks.bundled()
    assert packs.source.has_top_level("en")
    assert packs.source.has_top_level("common")
    assert packs.source.has_country("usa")
    # Everything else is downloaded. Bundling the whole catalogue would make every install pay
    # for data almost no run uses, and it grows without bound.
    assert not packs.source.has_top_level("ru")
    assert not packs.source.has_country("france")


def test_a_bundled_pack_loads_without_any_configuration() -> None:
    entry = DataPacks.bundled().load("person.lastName", "en")
    assert entry.values[:3] == ["Smith", "Johnson", "Williams"]
    assert entry.weighted


def test_a_country_address_skips_the_countries_folder_nobody_writes() -> None:
    entry = DataPacks.bundled().load("usa.docs.ssn", "en")
    assert entry.is_generator
    assert entry.generator is not None
    assert "<sequence" in entry.generator


def test_an_address_that_resolves_to_nothing_says_where_it_looked() -> None:
    # Not a locale, not a country, not a bucket — so it is read as relative to the locale.
    with pytest.raises(ValueError, match=r"looked for en/nonsense/here\.txt"):
        DataPacks.bundled().load("nonsense.here", "en")


def test_exists_answers_without_raising() -> None:
    packs = DataPacks.bundled()
    assert packs.exists("person.lastName", "en")
    assert not packs.exists("person.nosuchthing", "en")


# ── weighted packs ──────────────────────────────────────────────────────────────────────────


def test_counts_become_exact_shares(tmp_path: Path) -> None:
    root = tmp_path / "packs"
    (root / "xx" / "person").mkdir(parents=True)
    (root / "xx" / "person" / "lastName.txt").write_text(
        "---\nweighted: true\n---\nSmith,3\nZabrowski,1\n", encoding="utf-8"
    )
    entry = DataPacks(root).load("person.lastName", "xx")
    assert entry.values == ["Smith", "Zabrowski"]
    assert entry.percents == [75.0, 25.0]


def test_a_zero_count_is_dropped_rather_than_carried(tmp_path: Path) -> None:
    root = tmp_path / "packs"
    (root / "xx" / "person").mkdir(parents=True)
    (root / "xx" / "person" / "lastName.txt").write_text(
        "---\nweighted: true\n---\nSmith,3\nGone,0\n", encoding="utf-8"
    )
    assert DataPacks(root).load("person.lastName", "xx").values == ["Smith"]


def test_a_weighted_line_with_no_count_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "packs"
    (root / "xx" / "person").mkdir(parents=True)
    (root / "xx" / "person" / "lastName.txt").write_text(
        "---\nweighted: true\n---\nSmith\n", encoding="utf-8"
    )
    with pytest.raises(ValueError, match="has no count"):
        DataPacks(root).load("person.lastName", "xx")


# ── the project cascade ─────────────────────────────────────────────────────────────────────


def test_this_repository_is_a_project_so_every_locale_resolves() -> None:
    packs = DataPacks.for_project(REPO)
    assert packs.exists("person.lastName", "ru")
    assert packs.exists("person.lastName", "fr")


def test_a_project_pack_shadows_a_bundled_one(tmp_path: Path) -> None:
    root = tmp_path / "packs"
    (root / "en" / "person").mkdir(parents=True)
    (root / "en" / "person" / "lastName.txt").write_text("Onlyone\n", encoding="utf-8")
    (tmp_path / project_config.CONFIG_NAME).write_text(
        json.dumps({"dataPaths": ["packs"]}), encoding="utf-8"
    )
    packs = DataPacks.for_project(tmp_path)
    assert packs.load("person.lastName", "en").values == ["Onlyone"]
    # And everything the project did NOT override still resolves.
    assert packs.exists("person.male.firstName", "en")


def test_a_relative_path_is_relative_to_the_config_that_holds_it(tmp_path: Path) -> None:
    nested = tmp_path / "a" / "b"
    nested.mkdir(parents=True)
    (tmp_path / project_config.CONFIG_NAME).write_text(
        json.dumps({"dataPaths": ["./packs"], "locale": "fr"}), encoding="utf-8"
    )
    resolved = project_config.load(nested)
    assert resolved.data_paths == [tmp_path / "packs"]
    assert resolved.locale == "fr"


def test_a_config_that_is_not_json_is_named_not_ignored(tmp_path: Path) -> None:
    (tmp_path / project_config.CONFIG_NAME).write_text("{oops", encoding="utf-8")
    with pytest.raises(project_config.ConfigError, match="not valid JSON"):
        project_config.load(tmp_path)


def test_registering_a_pack_root_writes_it_relative_when_it_sits_below(tmp_path: Path) -> None:
    config = tmp_path / project_config.CONFIG_NAME
    project_config.register(config, [tmp_path / "tdcv2-packs" / "ru" / "packs"])
    written = json.loads(config.read_text(encoding="utf-8"))
    assert written["dataPaths"] == ["./tdcv2-packs/ru/packs"]

    # Registering the same root twice does not duplicate it.
    project_config.register(config, [tmp_path / "tdcv2-packs" / "ru" / "packs"])
    assert json.loads(config.read_text(encoding="utf-8"))["dataPaths"] == [
        "./tdcv2-packs/ru/packs"
    ]


# ── the registry ────────────────────────────────────────────────────────────────────────────


def _index(**overrides: object) -> str:
    document = {
        "schemaVersion": 1,
        "description": "test",
        "bundles": [
            {
                "id": "ru",
                "name": "Russian",
                "file": "bundles/ru.zip",
                "bytes": 10,
                "sha256": "ab" * 32,
                "locale": "ru",
            }
        ],
    }
    document.update(overrides)
    return json.dumps(document)


def test_an_index_parses_into_bundles() -> None:
    index = registry.parse_index(_index())
    assert index.find("ru").locale == "ru"


def test_an_unknown_bundle_lists_what_there_is() -> None:
    with pytest.raises(PackError, match="Available: ru"):
        registry.parse_index(_index()).find("de")


def test_an_index_from_a_newer_schema_says_to_update() -> None:
    with pytest.raises(PackError, match="update tdcv2"):
        registry.parse_index(_index(schemaVersion=2))


def test_a_malformed_index_is_refused_rather_than_guessed_at() -> None:
    with pytest.raises(PackError, match="not valid JSON"):
        registry.parse_index("{")
    with pytest.raises(PackError, match='"bundles" must be an array'):
        registry.parse_index(json.dumps({"schemaVersion": 1, "bundles": "no"}))


class _LocalRegistry(Registry):
    """A registry served from memory, so the install path is exercised without the network."""

    def __init__(self, files: dict[str, bytes]) -> None:
        super().__init__("http://example.invalid")
        self._files = files

    def _fetch(self, url: str) -> bytes:
        name = url[len(self.base_url) + 1 :]
        if name not in self._files:
            raise PackError(f"not found: {url}")
        return self._files[name]


def _zip(entries: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        for name, body in entries.items():
            zf.writestr(name, body)
    return buffer.getvalue()


def test_a_bundle_is_verified_before_a_single_byte_is_written(tmp_path: Path) -> None:
    # The zip nests everything under `<id>/packs/`, which is the registry's layout and the
    # bundler's business: both levels are stripped, so the address path lands in the store.
    archive = _zip({"ru/packs/ru/person/lastName.txt": "Иванов\n"})
    good = hashlib.sha256(archive).hexdigest()
    index = json.dumps(
        {
            "schemaVersion": 1,
            "bundles": [
                {
                    "id": "ru",
                    "name": "Russian",
                    "file": "bundles/ru.zip",
                    "bytes": len(archive),
                    "sha256": good,
                }
            ],
        }
    )
    pack_store = tmp_path / "store"
    client = _LocalRegistry({"index.json": index.encode(), "bundles/ru.zip": archive})
    result = client.install(client.index().find("ru"), pack_store)
    assert (pack_store / "ru" / "person" / "lastName.txt").read_text(encoding="utf-8") == "Иванов\n"
    assert result.paths == ["ru/person"]
    assert result.files == 1

    # A digest that does not match is refused — a generator quietly fed the wrong names produces
    # a dataset nobody can tell is wrong.
    wrong = index.replace(good, "cd" * 32)
    bad_client = _LocalRegistry({"index.json": wrong.encode(), "bundles/ru.zip": archive})
    with pytest.raises(PackError, match="failed its checksum"):
        bad_client.install(bad_client.index().find("ru"), tmp_path / "store2")


def _evil_client(entries: dict[str, str]) -> Registry:
    archive = _zip(entries)
    index = json.dumps(
        {
            "schemaVersion": 1,
            "bundles": [
                {
                    "id": "evil",
                    "name": "Evil",
                    "file": "bundles/evil.zip",
                    "bytes": len(archive),
                    "sha256": hashlib.sha256(archive).hexdigest(),
                }
            ],
        }
    )
    return _LocalRegistry({"index.json": index.encode(), "bundles/evil.zip": archive})


def test_an_entry_that_would_escape_the_store_is_refused(tmp_path: Path) -> None:
    # A zip can name `../../etc/something`, and an extractor that trusts the name writes wherever
    # it is told. The archive is data from the network; it does not get to choose paths.
    client = _evil_client({"evil/packs/../../escaped.txt": "no"})
    with pytest.raises(PackError, match="unsafe path"):
        client.install(client.index().find("evil"), tmp_path / "store")
    assert not (tmp_path / "escaped.txt").exists()


def test_an_archive_carrying_anything_but_its_own_packs_is_refused_whole(tmp_path: Path) -> None:
    # Not the bundle it claims to be. Unpacked, its files would scatter into a tree shared with
    # every other bundle, and nothing could take them apart again.
    client = _evil_client({"evil/packs/evil/a.txt": "fine\n", "somebodyelse/b.txt": "not\n"})
    with pytest.raises(PackError, match="refusing to unpack it"):
        client.install(client.index().find("evil"), tmp_path / "store")
    assert not (tmp_path / "store" / "evil").exists()


def test_the_store_reports_what_is_already_installed(tmp_path: Path) -> None:
    # From the books, not from a directory listing: `hand_unpacked` is a perfectly good tree,
    # but nothing records what it owns, so nothing could remove it cleanly either.
    (tmp_path / "hand_unpacked" / "person").mkdir(parents=True)
    store.write_installed(
        tmp_path, store.InstalledRecord(bundles=[store.InstalledBundle("ru", ["ru"], files=2)])
    )
    assert store.installed(tmp_path) == ["ru"]


def test_layers_are_searched_from_the_top_down(tmp_path: Path) -> None:
    low = tmp_path / "low" / "xx"
    high = tmp_path / "high" / "xx"
    low.mkdir(parents=True)
    high.mkdir(parents=True)
    (low / "a.txt").write_text("low\n", encoding="utf-8")
    (low / "b.txt").write_text("only-low\n", encoding="utf-8")
    (high / "a.txt").write_text("high\n", encoding="utf-8")

    layered = source.Layered(
        [source.Directory(tmp_path / "low"), source.Directory(tmp_path / "high")]
    )
    assert layered.read_lines("xx/a.txt")[0] == "high"
    assert layered.read_lines("xx/b.txt")[0] == "only-low"
