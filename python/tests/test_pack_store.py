"""The flat pack store: its books, what a bundle owns, and upgrading a store from before it.

Before the flat store, `pack add` unpacked to ``<store>/<id>/packs/…`` and wrote one ``dataPaths``
entry per bundle. Anyone who installed a pack has that on disk and in their config, and neither
`list` nor `remove` can read it any more — so the first ``tdcv2 pack`` after the upgrade has to
move it, in place, and say so. These tests are what stands between an existing user and a store
they would otherwise have to delete and download again.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tdcv2.cli.pack import run_pack
from tdcv2.packs import PackError, project_config, registry, store


def _put(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def _entry(bundle_id: str, paths: list[str]) -> store.InstalledBundle:
    return store.InstalledBundle(bundle_id, paths, "", "aa", 2)


# ── the store's books ───────────────────────────────────────────────────────────────────────


def test_a_missing_store_holds_nothing_and_says_so_without_raising(tmp_path: Path) -> None:
    assert store.installed(tmp_path / "nope") == []


def test_the_record_round_trips_with_its_ids_sorted(tmp_path: Path) -> None:
    store.write_installed(
        tmp_path,
        store.InstalledRecord(bundles=[_entry("usa", ["countries/usa"]), _entry("en", ["en"])]),
    )
    assert store.installed(tmp_path) == ["en", "usa"]
    assert store.read_installed(tmp_path).bundles[0].paths == ["en"]
    # The name matters: the store is a scan root and the loader skips ignored NAMES, so anything
    # without a leading dot here would be loaded as a pack.
    assert store.INSTALLED_FILE.startswith(".")
    assert (tmp_path / store.INSTALLED_FILE).read_text(encoding="utf-8").endswith("\n")


def test_the_record_is_written_the_same_bytes_five_implementations_write(tmp_path: Path) -> None:
    store.write_installed(
        tmp_path,
        store.InstalledRecord(bundles=[store.InstalledBundle("demo", ["demo/person"], files=1)]),
    )
    assert (tmp_path / store.INSTALLED_FILE).read_text(encoding="utf-8") == (
        "{\n"
        '  "schemaVersion": 1,\n'
        '  "bundles": [\n'
        "    {\n"
        '      "id": "demo",\n'
        '      "paths": [\n'
        '        "demo/person"\n'
        "      ],\n"
        '      "version": "",\n'
        '      "sha256": "",\n'
        '      "files": 1\n'
        "    }\n"
        "  ]\n"
        "}\n"
    )


def test_a_tree_nobody_recorded_is_not_installed(tmp_path: Path) -> None:
    (tmp_path / "en" / "person").mkdir(parents=True)
    assert store.installed(tmp_path) == []


def test_a_record_claiming_a_path_outside_the_store_is_refused(tmp_path: Path) -> None:
    _put(
        tmp_path / store.INSTALLED_FILE,
        json.dumps({"schemaVersion": 1, "bundles": [{"id": "evil", "paths": ["../../etc"]}]}),
    )
    with pytest.raises(PackError, match="outside the store"):
        store.read_installed(tmp_path)


def test_a_malformed_record_is_an_error_rather_than_an_empty_store(tmp_path: Path) -> None:
    # "Nothing is installed" would make `pack remove` claim there is nothing to delete while the
    # files sit there.
    _put(tmp_path / store.INSTALLED_FILE, "{ not json")
    with pytest.raises(PackError, match="not valid JSON"):
        store.read_installed(tmp_path)
    _put(tmp_path / store.INSTALLED_FILE, "[]")
    with pytest.raises(PackError, match="must be a JSON object"):
        store.read_installed(tmp_path)
    _put(tmp_path / store.INSTALLED_FILE, json.dumps({"schemaVersion": 1, "bundles": {}}))
    with pytest.raises(PackError, match='"bundles" must be an array'):
        store.read_installed(tmp_path)


def test_a_record_from_a_newer_tdcv2_says_to_update(tmp_path: Path) -> None:
    _put(tmp_path / store.INSTALLED_FILE, json.dumps({"schemaVersion": 2, "bundles": []}))
    with pytest.raises(PackError, match="newer tdcv2"):
        store.read_installed(tmp_path)


def test_with_bundle_replaces_the_same_id_and_without_bundle_drops_it() -> None:
    one = store.with_bundle(store.InstalledRecord(), _entry("en", ["en"]))
    again = store.with_bundle(one, store.InstalledBundle("en", ["en"], "", "aa", 9))
    assert len(again.bundles) == 1
    assert again.bundles[0].files == 9
    assert store.without_bundle(again, "en").bundles == []


# ── what a bundle owns ──────────────────────────────────────────────────────────────────────


def test_a_bundle_claims_the_one_subtree_it_fills() -> None:
    assert store.bundle_owned_paths(["ru/person/lastName.txt", "ru/city/name.txt"]) == ["ru"]


def test_a_country_claims_itself_never_the_shared_countries_folder() -> None:
    assert store.bundle_owned_paths(
        ["countries/russia/docs/inn.txt", "countries/russia/tax/x.txt"]
    ) == ["countries/russia"]


def test_files_that_share_no_parent_claim_each_top_level_entry() -> None:
    assert store.bundle_owned_paths(["en/a.txt", "countries/usa/b.txt"]) == ["countries", "en"]


def test_a_lone_file_at_the_root_is_claimed_as_itself() -> None:
    assert store.bundle_owned_paths(["loose.txt"]) == ["loose.txt"]


def test_a_bundle_claims_no_more_than_it_actually_fills() -> None:
    # A one-file country stub owns the folder holding that file, not the whole country — the
    # answer follows the files, so removal can never take more than the bundle brought.
    assert store.bundle_owned_paths(["countries/andorra/docs/nid.txt"]) == [
        "countries/andorra/docs"
    ]


def test_no_files_own_nothing() -> None:
    assert store.bundle_owned_paths([]) == []


def test_a_path_inside_is_the_root_itself_or_below_it(tmp_path: Path) -> None:
    assert store.is_path_inside(tmp_path / "a" / "b", tmp_path / "a")
    assert store.is_path_inside(tmp_path / "a", tmp_path / "a")
    assert not store.is_path_inside(tmp_path / "a" / ".." / ".." / "etc", tmp_path / "a")
    assert not store.is_path_inside(tmp_path / "other", tmp_path / "a")


def test_a_bundle_may_not_write_into_a_path_another_one_owns() -> None:
    record = store.InstalledRecord(bundles=[_entry("ru", ["ru"])])
    with pytest.raises(PackError, match='remove "ru" first'):
        store.assert_no_overlap("also_ru", ["ru/person"], record)
    # A sibling under the same shared folder is no overlap at all.
    store.assert_no_overlap(
        "usa",
        ["countries/usa"],
        store.InstalledRecord(bundles=[_entry("russia", ["countries/russia"])]),
    )


# ── the config's data paths ─────────────────────────────────────────────────────────────────


def test_the_per_bundle_entries_go_and_the_store_and_everything_outside_it_stay(
    tmp_path: Path,
) -> None:
    config = tmp_path / project_config.CONFIG_NAME
    _put(
        config,
        json.dumps(
            {
                "packStore": "./p",
                "dataPaths": ["./p/en/packs", "./p/usa/packs", "./p", "./my-own-lists"],
            }
        ),
    )
    assert project_config.remove_data_paths_inside(config, tmp_path / "p") == 2
    written = json.loads(config.read_text(encoding="utf-8"))
    assert written["dataPaths"] == ["./p", "./my-own-lists"]
    assert written["packStore"] == "./p"


def test_a_second_bundle_adds_no_second_entry(tmp_path: Path) -> None:
    config = tmp_path / project_config.CONFIG_NAME
    _put(config, json.dumps({"packStore": "./p"}))
    assert project_config.register(config, [tmp_path / "p"])
    assert not project_config.register(config, [tmp_path / "p"])
    assert json.loads(config.read_text(encoding="utf-8"))["dataPaths"] == ["./p"]


# ── the registry index ──────────────────────────────────────────────────────────────────────


def test_a_bundle_may_carry_a_version_and_the_store_writes_it_down() -> None:
    index = registry.parse_index(
        json.dumps(
            {
                "schemaVersion": 1,
                "bundles": [
                    {
                        "id": "ru",
                        "name": "Russian",
                        "file": "bundles/ru.zip",
                        "bytes": 1,
                        "sha256": "ab",
                        "version": "2026.07",
                    }
                ],
            }
        )
    )
    assert index.find("ru").version == "2026.07"


# ── upgrading a store written by an older tdcv2 ─────────────────────────────────────────────


def _old_project(tmp_path: Path, extra: dict[str, str] | None = None) -> tuple[Path, Path]:
    """A project as the old `pack add ru russia` left it: two bundle folders, each with its own
    ``packs/`` root, and two ``dataPaths`` entries pointing inside them."""
    pack_store = tmp_path / "tdcv2-packs"
    config = tmp_path / project_config.CONFIG_NAME
    _put(pack_store / "ru/packs/ru/person/lastName.txt", "---\nlocale: ru\n---\nИванов\n")
    _put(pack_store / "ru/packs/ru/city/name.txt", "---\nlocale: ru\n---\nОмск\n")
    _put(pack_store / "ru/packs/ru/_locale.json", '{"code":"ru"}\n')
    _put(
        pack_store / "russia/packs/countries/russia/docs/inn.txt",
        "---\naddress: russia.docs.inn\n---\n7707083893\n",
    )
    _put(
        pack_store / "russia/packs/countries/russia/bank/bic.txt",
        "---\naddress: russia.bank.bic\n---\n044525225\n",
    )
    for name, body in (extra or {}).items():
        _put(pack_store / name, body)
    _put(
        config,
        json.dumps(
            {
                "packStore": "./tdcv2-packs",
                "locale": "ru",
                "dataPaths": ["./tdcv2-packs/ru/packs", "./tdcv2-packs/russia/packs"],
                "keepThis": True,
            },
            indent=2,
        )
        + "\n",
    )
    return config, pack_store


def test_the_old_layout_is_recognised_and_a_flat_store_is_left_alone(tmp_path: Path) -> None:
    _, pack_store = _old_project(tmp_path)
    assert store.legacy_bundle_ids(pack_store) == ["ru", "russia"]
    flat = tmp_path / "flat"
    (flat / "ru").mkdir(parents=True)
    assert store.legacy_bundle_ids(flat) == []


def test_each_tree_moves_up_is_recorded_and_leaves_one_data_path(tmp_path: Path) -> None:
    config, pack_store = _old_project(tmp_path)

    result = store.migrate_store(pack_store, config)
    assert result is not None

    # On disk: the address path and nothing above it.
    assert "Иванов" in (pack_store / "ru/person/lastName.txt").read_text(encoding="utf-8")
    assert (pack_store / "ru/_locale.json").is_file()  # travels with its locale
    assert (pack_store / "countries/russia/docs/inn.txt").is_file()
    assert not (pack_store / "ru/packs").exists()
    assert not (pack_store / "russia").exists()

    # In the books: who owns what.
    record = store.read_installed(pack_store)
    assert [(b.id, b.paths) for b in record.bundles] == [
        ("ru", ["ru"]),
        ("russia", ["countries/russia"]),
    ]
    # Nothing to claim about an archive nobody kept.
    assert record.bundles[0].sha256 == ""
    assert record.bundles[0].files == 3

    # In the config: two per-bundle entries out, the store in, everything else kept.
    written = json.loads(config.read_text(encoding="utf-8"))
    assert written["dataPaths"] == ["./tdcv2-packs"]
    assert written["keepThis"] is True
    assert written["locale"] == "ru"
    assert result.dropped_data_paths == 2
    assert result.registered == "./tdcv2-packs"


def test_migrating_twice_does_nothing_the_second_time(tmp_path: Path) -> None:
    config, pack_store = _old_project(tmp_path)
    store.migrate_store(pack_store, config)
    assert store.migrate_store(pack_store, config) is None


def test_files_that_were_never_pack_data_stay_where_they_are(tmp_path: Path) -> None:
    config, pack_store = _old_project(tmp_path, {"ru/sources/lastName.csv": "Иванов,100\n"})
    result = store.migrate_store(pack_store, config)
    assert result is not None
    assert result.leftovers == ["ru/sources/lastName.csv"]
    assert (pack_store / "ru/sources/lastName.csv").is_file()
    assert (pack_store / "ru/person/lastName.txt").is_file()


def test_a_taken_destination_refuses_the_whole_migration(tmp_path: Path) -> None:
    config, pack_store = _old_project(tmp_path)
    # Something already sits where `ru` has to land.
    _put(pack_store / "ru/person/lastName.txt", "somebody else\n")

    with pytest.raises(PackError, match="collide"):
        store.migrate_store(pack_store, config)
    # The old tree is untouched, so the user can look and decide.
    assert (pack_store / "ru/packs/ru/person/lastName.txt").is_file()
    assert (pack_store / "ru/person/lastName.txt").read_text(encoding="utf-8") == "somebody else\n"
    assert json.loads(config.read_text(encoding="utf-8"))["dataPaths"] == [
        "./tdcv2-packs/ru/packs",
        "./tdcv2-packs/russia/packs",
    ]


def test_pack_migrates_before_it_does_anything_else_and_reports_on_stderr(
    tmp_path: Path, capsys
) -> None:
    config, pack_store = _old_project(tmp_path)

    assert run_pack(["remove", "russia"], tmp_path) == 0
    captured = capsys.readouterr()

    assert "used the old per-bundle layout" in captured.err
    assert "ru: ru/packs → ru (3 files)" in captured.err
    assert "dropped 2 per-bundle dataPaths entries" in captured.err

    # And the removal that followed acted on the migrated store.
    assert not (pack_store / "countries").exists()
    assert (pack_store / "ru/person/lastName.txt").is_file()
    assert [b.id for b in store.read_installed(pack_store).bundles] == ["ru"]
    assert json.loads(config.read_text(encoding="utf-8"))["dataPaths"] == ["./tdcv2-packs"]


def test_the_last_bundle_out_takes_the_store_out_of_the_config(tmp_path: Path, capsys) -> None:
    config, pack_store = _old_project(tmp_path)

    assert run_pack(["remove", "ru", "russia"], tmp_path) == 0
    captured = capsys.readouterr()

    assert "store now empty — unregistered" in captured.out
    assert json.loads(config.read_text(encoding="utf-8"))["dataPaths"] == []
    # The folders went with the bundles; only the store and its books are left.
    assert not (pack_store / "ru").exists()
    assert not (pack_store / "countries").exists()
    assert store.read_installed(pack_store).bundles == []
