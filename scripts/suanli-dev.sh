#!/bin/sh
# Launch the product's development desktop build against one reusable scratch home.
#
# The home keeps the stored gateway key, so a launch reaches the workspace instead of
# the key gate. It lives under a temporary root because `dev.ts` refuses anything else:
# a development run must never resolve the operator's own harness home.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
home=${SUANLI_DEV_HOME:-/tmp/suanli-dev-home}
mkdir -p "$home"
echo "suanli dev: DSH_HOME=$home"
cd "$root"
exec env -u ELECTRON_RUN_AS_NODE DSH_HOME="$home" corepack pnpm run dev:desktop "$@"
