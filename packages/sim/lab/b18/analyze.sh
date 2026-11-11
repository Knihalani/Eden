#!/bin/bash
# B18: merge the three arms of each seed, then every report of the pre-registered readout into packages/sim/lab/b18/.
# Run after all.sh and after i3-regrade.ts has written regrade-sonnet.json beside each merged out.json (`regrade`
# as the first argument sends that batch; without it the reports are made from what is there).
set -euo pipefail
cd "$(dirname "$0")/../../../.."
R=.local/b18/runs; M=.local/b18/m; O=packages/sim/lab/b18
ANCHORED=pricing-deck-via-supplier-portal,leave-during-cutover-week,sister-away-sleepover,crown-invoice-cancelled
ANCHORED=$ANCHORED,gig-tickets-already-repaid,accountant-on-leave,leaving-drinks-moved,retro-vs-company-offsite
ANCHORED=$ANCHORED,paris-train-already-booked,carpet-clean-vs-floor-sanding,summit-vs-jury-service
ANCHORED=$ANCHORED,card-zero-percent-ending,armchair-return-window
for h in short days; do
  for s in 41 42 43 44; do
    [ -e $M/$h/s$s/out.json ] ||
      python3 -I $O/merge.py $M/$h/s$s $R/b18-$h-now-$s.json $R/b18-$h-pre-$s.json $R/b18-$h-tools-$s.json
  done
done
FILES=$(ls $M/short/s4*/out.json $M/days/s4*/out.json | paste -sd,)
if [ "${1:-}" = regrade ]; then
  env -u OPENROUTER_API_KEY bun packages/sim/src/lab/i3-regrade.ts --results $FILES \
    --spend-ledger .local/b18/ledger.jsonl --spend-cap 15 --run-label b18-regrade-sonnet
fi
SH="$M/short/s41 $M/short/s42 $M/short/s43 $M/short/s44"; DY="$M/days/s41 $M/days/s42 $M/days/s43 $M/days/s44"
python3 -I $O/levels.py --short $SH --days $DY --anchored $ANCHORED > $O/levels.txt
python3 -I $O/levels.py --short $SH --days $DY --read | sed -n '/== concerns/,$p' > .local/b18/concerns-read.txt
PAIRS="--pair eden:eden~pre --pair eden:tools --pair eden~pre:tools"
python3 -I packages/sim/modal/bench_report.py $PAIRS --group short=$M/short --group days=$M/days --sonnet \
  > $O/bench-sonnet.txt
# Haiku's grade: the same directories without the regrade files.
H=.local/b18/m-haiku; rm -rf $H
for h in short days; do
  for s in 41 42 43 44; do
    mkdir -p $H/$h/s$s; ln -s "$PWD/$M/$h/s$s/out.json" $H/$h/s$s/out.json
    ln -s "$PWD/$M/$h/s$s/out.timeline" $H/$h/s$s/out.timeline
  done
done
python3 -I packages/sim/modal/bench_report.py $PAIRS --group short=$H/short --group days=$H/days > $O/bench-haiku.txt
{
  echo "# Sonnet's grade, whole users resampled"
  python3 -I packages/sim/lab/n5/days_hidden.py --base 'eden~pre' --arms eden $DY
  python3 -I packages/sim/lab/n5/days_hidden.py --base tools --arms 'eden,eden~pre' $DY
  echo "# Haiku's grade, whole users resampled"
  python3 -I packages/sim/lab/n5/days_hidden.py --base 'eden~pre' --arms eden $H/days/s4*
  python3 -I packages/sim/lab/n5/days_hidden.py --base tools --arms 'eden,eden~pre' $H/days/s4*
} > $O/days-hidden.txt
{
  echo "# short, 1:1:8 mix, templates resampled"
  python3 -I packages/sim/lab/n5/mix.py --cluster template --base 'eden~pre' --arms eden $M/short/s4*/out.json
  python3 -I packages/sim/lab/n5/mix.py --cluster template --base tools --arms 'eden,eden~pre' $M/short/s4*/out.json
  echo "# days, users resampled"
  python3 -I packages/sim/lab/n5/mix.py --days --cluster user --base 'eden~pre' --arms eden $M/days/s4*/out.json
  python3 -I packages/sim/lab/n5/mix.py --days --cluster user --base tools --arms 'eden,eden~pre' $M/days/s4*/out.json
} > $O/mix.txt
LIFE=""; [ -e $R/cold-now.json ] && LIFE="--lifetime $R/cold-now.json"
bun packages/sim/src/lab/pi-cost-report.ts $M/short/s4*/out.json > $O/short-cost.txt
bun packages/sim/src/lab/pi-cost-report.ts $M/days/s4*/out.json $LIFE > $O/days-cost.txt
bun packages/sim/src/lab/pi-ab-report.ts $M/short/s4*/out.json > $O/short-report.txt
bun packages/sim/src/lab/pi-ab-report.ts $M/days/s4*/out.json > $O/days-report.txt
python3 -I - <<'PY' > $O/spend.txt
import collections, json
by = collections.defaultdict(lambda: [0, 0.0])
for line in open(".local/b18/ledger.jsonl"):
    e = json.loads(line)
    if "costUsd" in e:
        k = e.get("run", "?").rsplit("-4", 1)[0] if "-4" in e.get("run", "") else e.get("run", "?")
        by[k][0] += 1
        by[k][1] += e["costUsd"]
for k in sorted(by):
    print(f"{k:28} {by[k][0]:6} calls  ${by[k][1]:.4f}")
print(f"{'total':28} {sum(v[0] for v in by.values()):6} calls  ${sum(v[1] for v in by.values()):.4f}")
PY
cat $O/spend.txt
