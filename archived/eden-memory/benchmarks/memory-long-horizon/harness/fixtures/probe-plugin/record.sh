#!/bin/sh
# Harness self-test probe. Records the payload and the hook's environment under $PROBE_OUT, one file per
# process (named by pid), then answers as $PROBE_MODE says:
#   silent (default)  no output
#   context           JSON additionalContext naming the event
#   text              plain-text stdout
#   block             exit 2 with stderr on UserPromptSubmit and PreCompact
#   fail              exit 1 with stderr
#   invalid           stdout that starts with { but is not JSON
#   slow              sleep $PROBE_SLEEP seconds (default 0.3), then no output
#   ask, deny         that permissionDecision on PreToolUse; no output elsewhere
#   watch             watchPaths on SessionStart ($PROBE_WATCH) and FileChanged ($PROBE_WATCH_AFTER, else
#                     $PROBE_WATCH): comma-separated names in the hook's folder
# With PROBE_SNAPSHOT=1 it also copies the transcript as it is when the hook runs.
payload="$PROBE_OUT/$$.json"
cat > "$payload"
printf '%s\n%s\n%s\n%s\n%s\n%s\n' "$PWD" "$CLAUDE_PLUGIN_ROOT" "$CLAUDE_PROJECT_DIR" "$HOME" "$EDEN_HOME" \
  "$EDEN_MEMORY_DIR" > "$PROBE_OUT/$$.env"
env | sed 's/=.*//' | sort > "$PROBE_OUT/$$.envnames"
event=$(sed -n 's/.*"hook_event_name":"\([A-Za-z]*\)".*/\1/p' "$payload")
if [ "${PROBE_SNAPSHOT:-}" = 1 ]; then
  transcript=$(sed -n 's/.*"transcript_path":"\([^"]*\)".*/\1/p' "$payload")
  cp "$transcript" "$PROBE_OUT/$$.transcript" 2>/dev/null || : > "$PROBE_OUT/$$.transcript"
fi
case "${PROBE_MODE:-silent}" in
  context) printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"probe saw %s"}}' "$event" "$event" ;;
  text) printf 'probe text for %s\n' "$event" ;;
  block)
    case "$event" in
      UserPromptSubmit | PreCompact) echo "probe blocks $event" >&2; exit 2 ;;
    esac ;;
  fail) echo "probe failed" >&2; exit 1 ;;
  invalid) printf '{not json' ; printf '}' ;;
  slow) sleep "${PROBE_SLEEP:-0.3}" ;;
  watch)
    case "$event" in
      SessionStart) names=$PROBE_WATCH ;;
      FileChanged) names=${PROBE_WATCH_AFTER:-$PROBE_WATCH} ;;
      *) exit 0 ;;
    esac
    paths=$(printf '%s' "$names" | tr ',' '\n' | sed "s|.*|\"$PWD/&\"|" | paste -sd, -)
    printf '{"hookSpecificOutput":{"hookEventName":"%s","watchPaths":[%s]}}' "$event" "$paths" ;;
  ask | deny)
    if [ "$event" = PreToolUse ]; then
      printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s"}}' "$PROBE_MODE"
    fi ;;
esac
exit 0
