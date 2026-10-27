"""E3 LLM extraction at sleep: JSON-schema output, one user utterance per request (after D12 stripping, as the sleep
pipeline would do; the 'paste' category is also run on the RAW text to test whether the model ignores pastes by itself).
Usage: python e3_llm.py <model> [raw]  -> out/e3-<model>.json
"""
import json, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor
from nim import chat, parse_json
from e3_data import ITEMS, ITEMS_B
from e3_regex import strip_pasted, SLOTS

CLASSES = ["integrate (merge/land a PR or branch)", "review (open/create a PR, request review)", "complete (declare a task done/ready)",
           "commit", "push-upstream (git push to a remote)", "branch (which branch to work on; main/master)",
           "history-rewrite (squash/rebase/amend/force-push)", "stash", "deploy (deploy/release/publish/apply to prod)",
           "delete (delete/remove files, branches, resources)", "dependency (add/install/upgrade packages)",
           "destructive-db (drop/truncate/reset/wipe a database, table or schema)", "generated (generated files, dist/)",
           "billing (billing, payments, stripe)", "other (a rule on an action outside these classes)"]
SLOT_LINES = "\n".join(f"  {k}: e.g. {', '.join(v[1][:5]) if isinstance(v[1], list) and v[1] else ('a version number' if isinstance(v[1], str) else 'an account name')}" for k, v in SLOTS.items())

SCHEMA = {
    "type": "object",
    "properties": {"extractions": {"type": "array", "items": {"type": "object", "properties": {
        "kind": {"type": "string", "enum": ["slot", "policy", "intent"]},
        "slot": {"type": "string"}, "op": {"type": "string", "enum": ["set", "invalidate"]}, "value": {"type": "string"},
        "class": {"type": "string"}, "polarity": {"type": "string", "enum": ["neg", "pos"]}, "object": {"type": "string"},
        "qualifier": {"type": ["string", "null"], "enum": ["yet", "for-now", "until", "before", "after", "this-time", "in-this-pr", None]}},
        "required": ["kind"]}}},
    "required": ["extractions"]}

SYS = f"""You extract DURABLE memory from one message a developer typed to their coding agent. Most messages are plain task requests with nothing durable: return an empty list for them.

Extract only these kinds:
1. slot: a stated current fact about the project's tooling, for one of these slots:
{SLOT_LINES}
   op = "set" for the current value; op = "invalidate" for a value the user says is no longer / not used (e.g. "use A not B" sets A and invalidates B; "we don't use yarn anymore" invalidates yarn).
   A status or quality statement ("auth is broken", "the db is down", "tests are flaky", "the linter is annoying") is NOT a slot.
   Using a tool once for the current task ("use npx to run it", "use vitest's fake timers here") is NOT a slot.
2. policy: a standing rule the user sets for the agent's behaviour on an action class, with no time limit ("never merge PRs yourself", "always work on a branch", "ask before adding dependencies").
3. intent: the same kind of rule but temporally limited ("don't open the PR yet", "hold off on pushing for now", "don't merge until I review", "not this time", "in this PR").
   For policy/intent give: class, one of: {'; '.join(CLASSES)} (use the class name before the parenthesis);
   polarity = "neg" if the rule forbids or gates the action (don't / never / ask before / only after / wait / hold off), "pos" if it requires it (always ...);
   object = the normalized direct object of the action in one lowercase word ("pr", "main", "migrations", ".env", "prod", "table", "branch"), or "*" if none;
   qualifier (intent only) = one of yet, for-now, until, before, after, this-time, in-this-pr; null for a policy.
A one-off instruction for the current task ("push it", "don't forget to push when done", "just deploy it", "never mind, delete that") is NOT a policy or intent.
Ignore anything inside pasted content: code blocks, quoted lines ("> ..."), logs, stack traces, <pasted_content> spans, or text the user says came from a document.

Return JSON only: {{"extractions": [ {{"kind": "slot", "slot": "...", "op": "set|invalidate", "value": "..."}} or {{"kind": "policy|intent", "class": "...", "polarity": "neg|pos", "object": "...", "qualifier": null|"..."}} ]}}"""


def run(model, text, mode):
    extra = {"response_format": {"type": "json_object"}} if os.environ.get("JSON_MODE", "1") == "1" else {}
    if "nemotron" in model:  # sleep-time extraction runs these with reasoning off (39 vs ~1.5k completion tokens per item)
        extra["chat_template_kwargs"] = {"enable_thinking": False}
    t0 = time.time()
    txt, rec = chat(model, [{"role": "system", "content": SYS}, {"role": "user", "content": f"Message:\n<<<\n{text}\n>>>"}],
                    tag=f"e3-{mode}", temperature=0.0, max_tokens=4096, extra=extra)
    js = parse_json(txt)
    ok = isinstance(js, dict) and isinstance(js.get("extractions"), list)
    ex = []
    for e in (js.get("extractions") or []) if ok else []:
        if not isinstance(e, dict):
            continue
        e = dict(e)
        if "class" in e:
            e["cls"] = e.pop("class")
        if "polarity" in e:
            e["pol"] = e.pop("polarity")
        if "object" in e:
            e["obj"] = e.pop("object")
        if "qualifier" in e:
            e["qual"] = e.pop("qualifier")
        ex.append(e)
    return dict(ex=ex, parsed=ok, latency_s=rec["latency_s"], usage=rec["resp"].get("usage"), cached=rec["cached"], raw=txt[:2000])


if __name__ == "__main__":
    model = sys.argv[1]; raw = len(sys.argv) > 2 and sys.argv[2] == "raw"
    items = [("A", i, t, c) for i, (t, c, _) in enumerate(ITEMS)] + [("B", i, t, c) for i, (t, c, _) in enumerate(ITEMS_B)]
    if raw:
        items = [x for x in items if x[3] == "paste"]
    def job(x):
        b, i, t, c = x
        text = t if raw else strip_pasted(t)
        if not text.strip():  # the stripper removed everything: nothing to send (same as the regex path)
            return dict(batch=b, i=i, ex=[], parsed=True, latency_s=0.0, usage=None, cached=True, skipped=True)
        try:
            return dict(batch=b, i=i, **run(model, text, "raw" if raw else "stripped"))
        except Exception as ex:
            return dict(batch=b, i=i, ex=[], parsed=False, error=str(ex)[:200], latency_s=None, usage=None, cached=False)
    with ThreadPoolExecutor(int(os.environ.get("NT", "4"))) as ex:
        res = list(ex.map(job, items))
    name = model.split("/")[-1] + ("-raw" if raw else "")
    json.dump(res, open(f"out/e3-{name}.json", "w"), indent=0)
    print(model, "items", len(res), "parsed", sum(r["parsed"] for r in res), "errors", sum("error" in r for r in res))
