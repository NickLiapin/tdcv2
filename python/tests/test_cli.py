"""The command line: what it accepts, what it writes, and what it exits with.

The exit code is part of the contract — a CI job branches on it — so every case asserts one. The
registry tests run against a zip on disk served over ``file://`` rather than the real one: a test
that needs the network is a test that fails on a train.
"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path

import pytest

from tdcv2.cli import init as init_cmd
from tdcv2.cli import pack as pack_cmd
from tdcv2.cli.args import UsageError, parse
from tdcv2.cli.main import main

CONFIG = """<tdc>
  <env count="3" seed="cli" local="en">
    <sequence name="Id"><gen type="increment" value="1"/></sequence>
    <sequence name="Name"><gen type="template" value="person.male.firstName"/></sequence>
  </env>
  <block>
    <line><data>${{Id}},${{Name}}</data></line>
  </block>
</tdc>
"""


@pytest.fixture
def config(tmp_path: Path) -> Path:
    path = tmp_path / "run.tdc"
    path.write_text(CONFIG, encoding="utf-8")
    return path


class TestArgs:
    def test_a_bare_file_is_the_input(self) -> None:
        assert parse(["users.tdc"]).input == "users.tdc"

    @pytest.mark.parametrize(
        "argv",
        [
            ["--engine", "2", "x.tdc"],
            ["--engine=2", "x.tdc"],
            ["x.tdc", "--engine", "2"],
            ["--stream", "x.tdc"],
        ],
    )
    def test_engine_two_has_four_spellings(self, argv: list[str]) -> None:
        # `--engine=2` and `--stream` are what the TypeScript CLI accepts; a config or a script
        # written against it has to keep working here.
        assert parse(argv).engine == 2

    def test_data_path_accumulates(self) -> None:
        options = parse(["--data-path", "a", "--data-path=b", "x.tdc"])
        assert options.data_paths == ["a", "b"]

    @pytest.mark.parametrize(
        ("argv", "message"),
        [
            (["--nope", "x.tdc"], "unknown option: --nope"),
            (["--engine", "9", "x.tdc"], 'invalid --engine "9"'),
            (["--mode", "sideways", "x.tdc"], 'invalid --mode "sideways"'),
            (["--count", "-3", "x.tdc"], "non-negative"),
            (["--count", "many", "x.tdc"], "non-negative"),
            (["--jobs", "0", "x.tdc"], "positive"),
            (["--seed"], "missing value for --seed"),
            (["--seed="], "missing value for --seed"),
            (["a.tdc", "b.tdc"], "unexpected positional argument: b.tdc"),
        ],
    )
    def test_refuses_what_it_cannot_obey(self, argv: list[str], message: str) -> None:
        with pytest.raises(UsageError, match=message.replace("(", r"\(")):
            parse(argv)


class TestGenerate:
    def test_writes_to_stdout(self, config: Path, capsys) -> None:
        assert main([str(config)]) == 0
        assert capsys.readouterr().out.splitlines() == ["1,James", "2,Robert", "3,John"]

    def test_writes_to_a_file(self, config: Path, tmp_path: Path, capsys) -> None:
        target = tmp_path / "out.csv"
        assert main([str(config), "-o", str(target)]) == 0
        assert target.read_text().splitlines() == ["1,James", "2,Robert", "3,John"]
        assert capsys.readouterr().out == ""

    def test_count_overrides_the_config(self, config: Path, capsys) -> None:
        assert main([str(config), "--count", "1"]) == 0
        assert capsys.readouterr().out.strip() == "1,James"

    def test_seed_changes_the_data_and_nothing_else(self, config: Path, capsys) -> None:
        main([str(config), "--seed", "other"])
        first = capsys.readouterr().out
        main([str(config), "--seed", "other"])
        assert capsys.readouterr().out == first
        main([str(config)])
        assert capsys.readouterr().out != first

    def test_a_missing_file_is_an_error_not_a_crash(self, tmp_path: Path, capsys) -> None:
        assert main([str(tmp_path / "nope.tdc")]) == 1
        assert "tdcv2:" in capsys.readouterr().err

    def test_an_invalid_config_reports_its_code(self, tmp_path: Path, capsys) -> None:
        bad = tmp_path / "bad.tdc"
        bad.write_text(CONFIG.replace("person.male.firstName", "nosuch.path.at.all"))
        assert main([str(bad)]) == 1
        assert "TDC071" in capsys.readouterr().err

    def test_no_input_is_a_usage_error(self, capsys) -> None:
        assert main([]) == 2
        assert "input file is required" in capsys.readouterr().err

    def test_help_and_version_succeed(self, capsys) -> None:
        assert main(["--help"]) == 0
        assert "The Data Constructor" in capsys.readouterr().out
        assert main(["--version"]) == 0
        assert "tdcv2 " in capsys.readouterr().out


class TestCheck:
    def test_a_valid_config_says_so_on_stderr(self, config: Path, capsys) -> None:
        assert main(["check", str(config)]) == 0
        captured = capsys.readouterr()
        assert "is valid" in captured.err
        # Nothing on stdout: `check` is for a hook, and a hook's stdout is noise.
        assert captured.out == ""

    def test_an_invalid_config_is_reported(self, tmp_path: Path, capsys) -> None:
        bad = tmp_path / "bad.tdc"
        bad.write_text(CONFIG.replace("person.male.firstName", "nosuch.path.at.all"))
        assert main(["check", str(bad)]) == 1
        assert "TDC071" in capsys.readouterr().err

    def test_needs_exactly_one_file(self, capsys) -> None:
        assert main(["check"]) == 2


class TestInit:
    def test_writes_a_project_config(self, tmp_path: Path, capsys) -> None:
        assert init_cmd.run_init(["--yes"], tmp_path) == 0
        written = json.loads((tmp_path / "tdcv2.config.json").read_text())
        # The store is stored RELATIVE, so the file survives being checked into git.
        assert written == {"packStore": "./tdcv2-packs", "locale": "en"}
        assert (tmp_path / "tdcv2-packs").is_dir()

    def test_locale_flag_is_honoured(self, tmp_path: Path) -> None:
        assert init_cmd.run_init(["--yes", "--locale", "ru"], tmp_path) == 0
        assert json.loads((tmp_path / "tdcv2.config.json").read_text())["locale"] == "ru"

    def test_refuses_to_clobber(self, tmp_path: Path, capsys) -> None:
        init_cmd.run_init(["--yes"], tmp_path)
        assert init_cmd.run_init(["--yes"], tmp_path) == 2
        assert "already exists" in capsys.readouterr().err

    def test_force_overwrites(self, tmp_path: Path) -> None:
        init_cmd.run_init(["--yes"], tmp_path)
        assert init_cmd.run_init(["--yes", "--force", "--locale", "de"], tmp_path) == 0
        assert json.loads((tmp_path / "tdcv2.config.json").read_text())["locale"] == "de"

    def test_unknown_flag_is_a_usage_error(self, tmp_path: Path, capsys) -> None:
        assert init_cmd.run_init(["--sideways"], tmp_path) == 2
        assert "unknown option for init" in capsys.readouterr().err


def build_registry(root: Path) -> str:
    """A registry on disk, served over ``file://``. Same shape as the real one."""
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
        )
    )
    return f"file://{root}"


class TestPack:
    def test_without_a_config_it_says_to_run_init(self, tmp_path: Path, capsys) -> None:
        assert pack_cmd.run_pack(["list"], tmp_path) == 2
        assert "run `tdcv2 init` first" in capsys.readouterr().err

    def test_the_whole_lifecycle(self, tmp_path: Path, capsys) -> None:
        project = tmp_path / "project"
        project.mkdir()
        url = build_registry(tmp_path / "registry")
        init_cmd.run_init(["--yes"], project)
        capsys.readouterr()

        assert pack_cmd.run_pack(["list", f"--registry={url}"], project) == 0
        assert "demo" in capsys.readouterr().out

        assert pack_cmd.run_pack(["add", "demo", f"--registry={url}"], project) == 0
        capsys.readouterr()
        registered = json.loads((project / "tdcv2.config.json").read_text())
        assert registered["dataPaths"] == ["./tdcv2-packs/demo/packs"]
        assert (project / "tdcv2-packs" / "demo" / "packs").is_dir()

        assert pack_cmd.run_pack(["list", f"--registry={url}"], project) == 0
        assert "installed" in capsys.readouterr().out

        assert pack_cmd.run_pack(["remove", "demo"], project) == 0
        capsys.readouterr()
        assert json.loads((project / "tdcv2.config.json").read_text())["dataPaths"] == []
        assert not (project / "tdcv2-packs" / "demo").exists()

    def test_an_installed_pack_is_usable(self, tmp_path: Path, capsys) -> None:
        project = tmp_path / "project"
        project.mkdir()
        url = build_registry(tmp_path / "registry")
        init_cmd.run_init(["--yes"], project)
        pack_cmd.run_pack(["add", "demo", f"--registry={url}"], project)
        capsys.readouterr()

        config = project / "use.tdc"
        config.write_text(
            '<tdc><env count="2" seed="s" local="en">'
            '<sequence name="L"><gen type="template" value="demo.person.lastName"/></sequence>'
            "</env><block><line><data>${{L}}</data></line></block></tdc>"
        )
        assert main([str(config)]) == 0
        for line in capsys.readouterr().out.splitlines():
            assert line in ("Ivanov", "Petrov")

    def test_an_unknown_bundle_lists_what_there_is(self, tmp_path: Path, capsys) -> None:
        project = tmp_path / "project"
        project.mkdir()
        url = build_registry(tmp_path / "registry")
        init_cmd.run_init(["--yes"], project)
        capsys.readouterr()

        assert pack_cmd.run_pack(["add", "nosuch", f"--registry={url}"], project) == 2
        assert "Available: demo" in capsys.readouterr().err

    def test_a_tampered_archive_is_refused(self, tmp_path: Path, capsys) -> None:
        project = tmp_path / "project"
        project.mkdir()
        registry = tmp_path / "registry"
        url = build_registry(registry)
        # The bytes change, the published digest does not. Data quietly altered on the way would
        # produce a dataset nobody could tell was wrong, so it must not install.
        (registry / "bundles" / "demo.zip").write_bytes(b"not a zip at all")
        init_cmd.run_init(["--yes"], project)
        capsys.readouterr()

        assert pack_cmd.run_pack(["add", "demo", f"--registry={url}"], project) == 2
        assert "bytes" in capsys.readouterr().err
        assert not (project / "tdcv2-packs" / "demo").exists()

    def test_removing_something_absent_is_a_clean_no_op(self, tmp_path: Path, capsys) -> None:
        project = tmp_path / "project"
        project.mkdir()
        init_cmd.run_init(["--yes"], project)
        capsys.readouterr()

        # Exit 0, not 1: `remove` is asked for to reach a state, and that state already holds.
        assert pack_cmd.run_pack(["remove", "demo"], project) == 0
        assert "nothing to remove" in capsys.readouterr().err

    def test_an_unknown_subcommand_is_a_usage_error(self, tmp_path: Path, capsys) -> None:
        project = tmp_path / "project"
        project.mkdir()
        init_cmd.run_init(["--yes"], project)
        capsys.readouterr()

        assert pack_cmd.run_pack(["frobnicate"], project) == 2
        assert "unknown pack command" in capsys.readouterr().err
