"""Do the five implementations disagree about anything?

Test counts do not answer that. TypeScript has thousands of unit tests and the ports have
hundreds, which says how each was built and nothing about whether they behave alike. This runs one
corpus of configs through all five and diffs the set of diagnostic CODES each reports. A
disagreement is a portability bug by definition: the same config, accepted by one implementation
and refused by another.

    python3 fixtures/parity/audit.py            # report
    python3 fixtures/parity/audit.py --strict   # exit 1 on any disagreement

The corpus is deliberately made of BROKEN configs. Data agreement is already pinned by
`fixtures/cross-language/` — 111 shared cases, 216 engine comparisons, byte-identical output. What
those cannot catch is a check one implementation performs and another skips, because a config that
is never rejected produces no data to compare.

Wording is not compared, only the codes and their presence. The code is the contract; the sentence
is edited for clarity over time.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CODE = re.compile(r"(?:error|warning)\[(TDC\d{3})\]")


def envelope(body: str, env_attrs: str = "", data: str = "${{X}}") -> str:
    return (
        f'<tdc><env count="3" seed="a" local="en"{env_attrs}>\n{body}\n'
        f"</env><block><line><data>{data}</data></line></block></tdc>\n"
    )


def sequence(gen: str, name: str = "X") -> str:
    return envelope(f'  <sequence name="{name}">{gen}</sequence>')


#: Each entry is one config that is wrong in exactly one way. Named after what it is wrong about,
#: so a disagreement reads as a sentence rather than as a number.
CORPUS: dict[str, str] = {
    # generators — attributes that are not read, and values that cannot be used
    "number/unknown-min-max": sequence('<gen type="number" min="abc" max="9"/>'),
    "number/unknown-attribute": sequence('<gen type="number" range="1..9" nonsense="1"/>'),
    "number/unknown-distribution": sequence('<gen type="number" range="1..9" distribution="no"/>'),
    "text/no-value": sequence('<gen type="text"/>'),
    "text/unknown-attribute": sequence('<gen type="text" value="a,b" nonsense="1"/>'),
    "text/percent-does-not-add-up": sequence('<gen type="text" value="a,b" percent="70,20,10"/>'),
    "regex/unparsable": sequence('<gen type="regex" value="[unclosed"/>'),
    "regex/unknown-attribute": sequence('<gen type="regex" value="[a-z]{3}" nonsense="1"/>'),
    "advanced-regex/unparsable": sequence('<gen type="advanced_regex" value="(?&lt;bad"/>'),
    "symbol/no-set": sequence('<gen type="symbol" chars="" length="3"/>'),
    "symbol/unknown-attribute": sequence('<gen type="symbol" chars="ab" length="3" nope="1"/>'),
    "increment/non-numeric": sequence('<gen type="increment" value="abc"/>'),
    "increment/unknown-attribute": sequence('<gen type="increment" value="1" nonsense="1"/>'),
    "file/missing": sequence('<gen type="file" src="./nope.txt"/>'),
    "file/no-src": sequence('<gen type="file"/>'),
    "file/unknown-attribute": sequence('<gen type="file" src="./nope.txt" nonsense="1"/>'),
    "date/unparsable-from": sequence('<gen type="date" from="notadate" to="2020-01-01"/>'),
    "date/half-a-range": sequence('<gen type="date" from="2020-01-01"/>'),
    "date/unknown-locale": sequence('<gen type="date" range="2020-01-01..2020-12-31" local="zz"/>'),
    "date/unterminated-format": sequence(
        '<gen type="date" range="2020-01-01..2020-12-31" format="[unclosed"/>'
    ),
    "template/unknown-path": sequence('<gen type="template" value="nosuch.path.here"/>'),
    "template/b_day-unknown-attribute": sequence(
        '<gen type="template" value="person.b_day" nonsense="1"/>'
    ),
    "template/date.range-without-range": sequence('<gen type="template" value="date.range"/>'),
    "template/date.range-with-from-to": sequence(
        '<gen type="template" value="date.range" from="2020-01-01" to="2020-12-31"/>'
    ),
    "timeseries/non-numeric-step": sequence('<gen type="timeseries" start="1" step="abc"/>'),
    "http/no-url": sequence('<gen type="http"/>'),
    "http/unusable-url": sequence('<gen type="http" url="notaurl"/>'),
    "pattern/nothing-to-draw": sequence('<gen type="pattern"/>'),
    "anomaly/not-a-probability": sequence('<gen type="text" value="a,b,c" anomaly="10x"/>'),
    "missing/probability-above-one": sequence('<gen type="number" value="1..9" missing="2"/>'),
    "anomaly/nothing-numeric-to-perturb": sequence(
        '<gen type="text" value="alpha,beta,gamma" anomaly="0.3"/>'
    ),
    # pools
    "pool/nobody-draws-from-it": envelope(
        '  <pool name="D" count="3"><sequence name="c">'
        '<gen type="text" value="A,B"/></sequence></pool>',
        data="x",
    ),
    "pool/filter-that-can-never-match": envelope(
        '  <pool name="D" count="3"><sequence name="c">'
        '<gen type="text" value="A,B"/></sequence></pool>\n'
        '  <sequence name="R"><gen type="pool" value="D" filter="c == North"/></sequence>',
        data="${{R.c}}",
    ),
    # structure
    # Was "structure/no-env", which reported nothing in all five and was right to: a config
    # with no <env> runs on the default count and a random seed, so there was nothing to
    # report and the entry claimed a mistake that is not one. The missing ROOT is, and had
    # no entry.
    "structure/no-tdc-root": (
        '<env count="3" seed="a"><sequence name="X">'
        '<gen type="text" value="a"/></sequence></env>\n'
    ),
    "structure/no-block": '<tdc><env count="3" seed="a"/></tdc>\n',
    "structure/duplicate-name": envelope(
        '  <sequence name="X"><gen type="text" value="a"/></sequence>\n'
        '  <sequence name="X"><gen type="text" value="b"/></sequence>'
    ),
    "structure/non-numeric-count": (
        '<tdc><env count="abc" seed="a" local="en"><sequence name="X">'
        '<gen type="text" value="a"/></sequence></env>'
        "<block><line><data>${{X}}</data></line></block></tdc>\n"
    ),
    "structure/reference-to-nothing": envelope(
        '  <sequence name="X"><gen type="text" value="a"/></sequence>', data="${{Nope}}"
    ),
    "structure/unknown-env-attribute": envelope(
        '  <sequence name="X"><gen type="text" value="a"/></sequence>', ' nonsense="1"'
    ),
    "structure/unknown-sequence-attribute": envelope(
        '  <sequence name="X" nonsense="1"><gen type="text" value="a"/></sequence>'
    ),
    # A locale is not a closed list — it is whichever packs are installed — so `local="zzz"`
    # on a config that consults no pack is not a mistake anyone can name, and the entry used
    # to sit at (none) claiming otherwise. Where the locale IS consulted the check exists and
    # is precise: the address is real, this locale does not ship it.
    "structure/unknown-locale": (
        '<tdc><env count="3" seed="a" local="zzz"><sequence name="X">'
        '<gen type="template" value="person.lastName"/></sequence></env>'
        "<block><line><data>${{X}}</data></line></block></tdc>\n"
    ),
    # constructs
    "mix/directly-inside-sequence": envelope(
        '  <sequence name="X"><mix percent="70,40">'
        '<gen type="text" value="a"/><gen type="text" value="b"/></mix></sequence>'
    ),
    "each/on-a-single-value": (
        '<tdc><env count="3" seed="a" local="en"><sequence name="X">'
        '<gen type="text" value="one"/></sequence></env>'
        '<block><line each="X"><data>${{X}}</data></line></block></tdc>\n'
    ),
    "repeat/non-numeric": sequence('<gen type="text" value="a,b" repeat="abc"/>'),
    "if/unparsable-expression": (
        '<tdc><env count="3" seed="a" local="en"><sequence name="X">'
        '<gen type="text" value="a"/></sequence></env>'
        '<block><line if="X ??? 1"><data>${{X}}</data></line></block></tdc>\n'
    ),
    # `mask="qqq"` is a perfectly good mask of three literal characters, and the column it
    # makes is a visible constant rather than a silent no-op — the entry named a mistake the
    # grammar does not have. A malformed INDEX is the one thing a mask is checked for.
    "mask/not-a-mask": sequence('<gen type="text" value="abc" mask="x[1-2]"/>'),
    "interpolation/unknown-filter": envelope(
        '  <sequence name="X"><gen type="text" value="a"/></sequence>', data="${{X|nosuchfilter}}"
    ),
    "compute/unknown-tag": envelope(
        '  <sequence name="X"><gen type="text" value="a"/></sequence>\n'
        "  <compute name=\"C\"><nosuchtag/></compute>"
    ),
}


def typescript(path: Path) -> list[str]:
    return run(["node", str(ROOT / "typescript/dist/cli/main.js"), str(path)])


def java(path: Path) -> list[str]:
    jars = sorted((ROOT / "java/build/libs").glob("tdcv2-*-cli.jar"))
    if not jars:
        raise SystemExit("build the Java CLI first: cd java && ./gradlew cliJar")
    return run(["java", "-jar", str(jars[-1]), str(path)])


def csharp(path: Path) -> list[str]:
    dll = ROOT / "csharp/Tdcv2.Cli.Tool/bin/Debug/net6.0/Tdcv2.Cli.dll"
    if not dll.exists():
        raise SystemExit("build the C# CLI first: cd csharp && dotnet build Tdcv2.Cli.Tool")
    return run(["dotnet", str(dll), "check", str(path)])


def python(path: Path) -> list[str]:
    return run(
        [str(ROOT / "python/.venv/bin/python"), "-m", "tdcv2.cli", str(path)],
        env_path=str(ROOT / "python/src"),
    )


def rust(path: Path) -> list[str]:
    binary = ROOT / "rust/target/debug/tdcv2"
    if not binary.exists():
        raise SystemExit("build the Rust CLI first: cd rust && cargo build")
    return run([str(binary), "check", str(path)])


def run(command: list[str], env_path: str | None = None) -> list[str]:
    import os

    env = dict(os.environ)
    if env_path:
        env["PYTHONPATH"] = env_path
    done = subprocess.run(command, capture_output=True, text=True, env=env, timeout=120)
    return sorted(set(CODE.findall(done.stdout + done.stderr)))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true", help="exit 1 on any disagreement")
    args = parser.parse_args()

    disagreements: list[str] = []
    with tempfile.TemporaryDirectory(prefix="tdc-parity-") as directory:
        for name, config in CORPUS.items():
            path = Path(directory) / "case.tdc"
            path.write_text(config, encoding="utf-8")

            found = {
                "ts": typescript(path),
                "java": java(path),
                "py": python(path),
                "cs": csharp(path),
                "rust": rust(path),
            }
            if len(set(map(tuple, found.values()))) == 1:
                print(f"  agree     {name:<40} {','.join(found['ts']) or '(none)'}")
            else:
                disagreements.append(name)
                print(f"! DISAGREE  {name}")
                for language, codes in found.items():
                    print(f"      {language:<5} {','.join(codes) or '(none)'}")

    print(f"\n{len(CORPUS) - len(disagreements)}/{len(CORPUS)} agree")
    if disagreements:
        print("disagreements: " + ", ".join(disagreements))
    return 1 if disagreements and args.strict else 0


if __name__ == "__main__":
    sys.exit(main())
