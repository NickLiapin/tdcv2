#!/usr/bin/env bash
# Regenerate the parser from the shared grammar.
#
# The grammar in `../grammar/` is the source of truth for every implementation — one file, so a
# syntax change cannot land in one language and not the others. The generated Python is checked
# in rather than built on install: a user installing from PyPI should not need a JDK, and ANTLR's
# generator is a Java program.
#
# Run this whenever `grammar/*.g4` changes, then commit the result.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
grammar="$(cd "$root/../grammar" && pwd)"
target="$root/src/tdcv2/parser/generated"

# The generator lives in the ANTLR tool jar, which Gradle already downloaded for the Java build.
# Reusing it keeps every implementation on one ANTLR version without a second package manager.
# Pinned to the version the Java build uses. Gradle's own distribution ships an OLDER antlr
# runtime, and if that one wins the classpath the tool emits an ATN the modern Python runtime
# cannot read — with an error that names neither version.
ANTLR_VERSION="${ANTLR_VERSION:-4.13.2}"
classpath="$(find "$HOME/.gradle/caches" -name '*.jar' 2>/dev/null \
  | grep -E "antlr4?-(runtime-)?$ANTLR_VERSION|antlr-runtime-3|ST4|stringtemplate|treelayout" \
  | grep -vE 'sources|javadoc' | tr '\n' ':')"
if ! echo "$classpath" | grep -q "antlr4-$ANTLR_VERSION.jar"; then
  echo "ANTLR $ANTLR_VERSION is not in the Gradle cache — run ./gradlew build in ../java first." >&2
  exit 1
fi

# Generated in a scratch copy: the tool writes the lexer's .tokens beside the grammar, and the
# parser reads it from there. Pointing it at the shared folder would leave build output in it.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$grammar"/*.g4 "$work/"
(cd "$work" && java -cp "$classpath" org.antlr.v4.Tool \
  -Dlanguage=Python3 -visitor -no-listener TDCLexer.g4 TDCParser.g4)

mkdir -p "$target"
cp "$work"/TDCLexer.py "$work"/TDCParser.py "$work"/TDCParserVisitor.py "$target/"
cp "$work"/*.interp "$work"/*.tokens "$target/"
touch "$target/__init__.py"
echo "parser regenerated into $target"
