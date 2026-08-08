"""The surface the Python binding page documents, exercised exactly as the page shows it.

`webdoc/docs/bindings/python.mdx` promised `to_string`, `iterate`, `to_array` and `get_at`
— four names that do not exist here, so the page's very first example raised
``AttributeError``. It survived because the documentation checker runs the ``.tdc`` configs
in the docs and not the language snippets, which is exactly the blind spot this file fills
for Python: every call below is copied from the page, and a rename here fails the build.

The capabilities were never missing. Python spells them the way Python does — ``str(data)``,
``for row in data``, ``data[3]``, ``len(data)`` — and the page now says so.
"""

from __future__ import annotations

from pathlib import Path

from tdcv2 import TDC

CONFIG = (
    '<tdc><env count="3" seed="s">'
    '<sequence name="Gender"><gen type="text" value="male,female"/></sequence>'
    "</env><block><line><data>${{Gender}}</data></line></block></tdc>"
)


def test_the_page_example_runs(tmp_path: Path) -> None:
    data = TDC(config_string=CONFIG)

    # print(data)
    assert str(data).splitlines() == ["female", "male", "male"]

    # for row in data: print(row["Gender"])
    assert [row["Gender"] for row in data] == ["female", "male", "male"]

    # data.write_file("users.csv")
    target = tmp_path / "users.csv"
    data.write_file(target)
    assert target.read_text(encoding="utf-8") == str(data)


def test_one_row_and_a_count_without_materialising_the_prose() -> None:
    """`data[3]` and `len(data)`, the two the page names beside the loop."""
    data = TDC(config_string=CONFIG)
    assert len(data) == 3
    assert data[1]["Gender"] == "male"
    assert [row["Gender"] for row in data.to_list()] == ["female", "male", "male"]


def test_the_snake_case_names_the_page_lists_are_all_there() -> None:
    """The page ends with a list of names. A list nobody checks is how the last one rotted."""
    data = TDC(config_string=CONFIG)
    for name in (
        "write_file",
        "to_list",
        "preflight",
        "seed_info",
        "uses_http",
        "diagnostics",
        "count",
        "engine",
    ):
        assert hasattr(data, name), f"the binding page documents {name}, and it is gone"
