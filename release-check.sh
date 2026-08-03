#!/usr/bin/env bash
#
# One command that answers one question: is this ready to publish?
#
# It exists because 0.1.5 was not. Every check in the repository was green — the
# five test suites, the documentation audits, the fixture coverage — and the Rust
# crate still went to crates.io with no data packs inside it, so `cargo install
# tdcv2` produced a binary that could not generate a single name.
#
# Nothing was broken. The checks all read the WORKING TREE. Not one of them
# packages an artefact, and the one that does — `rust/scripts/verify-crate.mjs`,
# written after this same bug happened once before — was wired into nothing and
# had to be remembered. It was not.
#
# So this runs everything, in the order that fails cheapest first, and reports
# the whole picture rather than stopping at the first red. Nothing here publishes:
# it only decides whether publishing would be honest.
#
#   ./release-check.sh
#
# Takes several minutes. The artefact stage builds the crate cold, outside the
# repository, because that is the only way to see what a stranger receives.

set -uo pipefail
cd "$(dirname "$0")"

names=()
codes=()
seconds=()

step() {
  local label="$1"; shift
  printf '\n\033[1m── %s\033[0m\n' "$label"
  local start; start=$SECONDS
  "$@"
  local code=$?
  names+=("$label"); codes+=("$code"); seconds+=("$((SECONDS - start))")
  if [ "$code" -eq 0 ]; then
    printf '\033[32m   ok\033[0m (%ss)\n' "$((SECONDS - start))"
  else
    printf '\033[31m   FAILED (exit %s)\033[0m (%ss)\n' "$code" "$((SECONDS - start))"
  fi
}

# A dirty tree is not a blocker — plenty of releases are prepared and checked
# before the commit — but an unnoticed leftover is how the wrong bytes ship, so
# it is said out loud rather than judged.
printf '\033[1mWorking tree\033[0m\n'
if [ -z "$(git status --porcelain)" ]; then
  echo "   clean, at $(git rev-parse --short HEAD)"
else
  echo "   $(git status --porcelain | wc -l | tr -d ' ') uncommitted path(s) — these are what will be released"
fi

# 1. The cheapest and most embarrassing failure: the five version declarations
#    disagreeing. `verify-artefacts` refuses before it builds anything, so this
#    costs a second and saves ten minutes.
step "Versions agree across all five" \
  node scripts/verify-artefacts.mjs --only nothing

# 2. Sources: lint, types, unit tests, shared fixtures, documentation export,
#    the fixture-coverage audit.
step "npm run check (sources, docs, fixture coverage)" \
  npm run check --silent

# 3. All five implementations against the shared contract.
step "five-ways (every implementation's own suite)" \
  node scripts/five-ways.mjs

# 4. Every documented example, run on all five. Catches a page that promises
#    what one implementation does not do.
step "documentation examples through all five" \
  node scripts/audit-doc-examples-five-ways.mjs

# 5. The artefacts, built and run the way a stranger receives them. This is the
#    stage that 0.1.5 needed and did not get.
step "artefacts (crate, jar, both NuGet packages)" \
  node scripts/verify-artefacts.mjs

printf '\n\033[1m%s\033[0m\n' "════════════════════════════════════════════════════════"
failed=0
for i in "${!names[@]}"; do
  if [ "${codes[$i]}" -eq 0 ]; then
    printf '  \033[32m✓\033[0m %-52s %4ss\n' "${names[$i]}" "${seconds[$i]}"
  else
    printf '  \033[31m✗\033[0m %-52s %4ss\n' "${names[$i]}" "${seconds[$i]}"
    failed=$((failed + 1))
  fi
done
printf '\033[1m%s\033[0m\n' "════════════════════════════════════════════════════════"

if [ "$failed" -ne 0 ]; then
  printf '\n\033[31m%s stage(s) failed — do not publish.\033[0m\n' "$failed"
  exit 1
fi

printf '\n\033[32mReady to publish.\033[0m Sources, all five implementations, the\n'
printf 'documentation and every artefact were built and run.\n\n'
printf 'Publishing itself is in temp_docs/publishing-checklist.md — this script\n'
printf 'deliberately does not do it.\n'
