#!/bin/bash
# Record only: `--connector-mix` was deleted with the local-copy trials (D495); run at commit 225625db0.
# qrun.sh NAME MIX LOST CONFIG [extra flags]
cd /home/user/Eden; unset BUN_OPTIONS
name=$1; mix=$2; lost=$3; cfg=$4; shift 4
bun packages/sim/src/quality-cli.ts --users 16 --sessions 20 --updates 0.6 --deletes 0.1 --jobs 4 --push signals \
  --connector-mix "$mix" --lost-notices "$lost" --config "$cfg" "$@" > .local/f1/q-$name.json 2> .local/f1/q-$name.err || echo "FAILED $name"
