#!/bin/sh
# Local checks before a commit: types, documentation, and the publishable-tree check.
#
# This script is not active by default. To enable it for this clone, point git at the tracked hooks directory:
#
#   git config core.hooksPath scripts/hooks
#
# To disable it again:
#
#   git config --unset core.hooksPath
#
# To skip it for one commit, use `git commit --no-verify`.
#
# The full test suite is not run here. It takes about 20 seconds, which is too slow for a hook.
# Run `npm test` and `npm run build` yourself before you integrate a change.

set -eu

cd "$(git rev-parse --show-toplevel)"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

status=0
run() {
  printf '%s\n' "pre-commit: npm run $1"
  npm run --silent "$1" || status=1
}

run typecheck
run check:docs
run check:publishable

if [ "$(git config --get core.hooksPath || true)" != "scripts/hooks" ]; then
  printf '%s\n' "pre-commit: git does not run this script yet. To enable it: git config core.hooksPath scripts/hooks"
fi

if [ "$status" -ne 0 ]; then
  printf '%s\n' "pre-commit: a check failed; the commit is stopped. Correct the problem, or use --no-verify to skip the checks." >&2
fi
exit "$status"
