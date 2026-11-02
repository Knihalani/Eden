#!/bin/bash
# runs jobs from a list, N at a time: each line "pi|hermes SUITES SEED LABEL"
N=$1; LIST=$2
R=${HAIKU_DIR:-.local/haiku}/p2
while read -r h s seed label; do
  [ -z "$h" ] && continue
  if [ -f $R/runs/$label.log ] && grep -q "^exit=" $R/runs/$label.log; then continue; fi
  while [ $(pgrep -fc "run.sh") -ge $N ]; do sleep 5; done
  nohup "$(dirname "$0")/run.sh" $h $s $seed $label > /dev/null 2>&1 &
  sleep 3
done < $LIST
wait
echo QUEUE-DONE
