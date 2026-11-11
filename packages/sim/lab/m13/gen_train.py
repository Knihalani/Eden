"""M13 training set: contrastive sets of user turns written by Haiku. Each set holds eight messages about one topic,
in one language, at one length and one punctuation style, so no surface cue (length, a question mark, the language,
the topic's words) tells the kinds apart: three acting requests in different shapes, a question about acting, a
question for information, chatter, a personal intent and a statement. A different brief and generator from S4's
(gen_blind4.py), which is never read here.

    python3 -I packages/sim/lab/m13/gen_train.py OUT.jsonl [--calls-scale 1.0]
"""
import json, os, random, re, sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from haiku import call  # noqa: E402

BAR = {"en": "English", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian", "pt": "Portuguese",
       "nl": "Dutch", "pl": "Polish", "hi": "Hindi (Devanagari, with the English loanwords people use)"}
EXTRA = {"sv": "Swedish", "tr": "Turkish", "ru": "Russian", "ja": "Japanese", "zh": "Simplified Chinese",
         "id": "Indonesian", "ro": "Romanian", "cs": "Czech", "hi-latn": "Hinglish (Hindi in Latin letters)"}
CALLS = {**{k: 60 for k in BAR}, "en": 260, **{k: 20 for k in EXTRA}}
SHAPES = [
    "the user's own need or obligation (\"I need to pay the gas bill by Friday\", \"we have to renew X\")",
    "a suggestion (\"let's move dinner to 8\", \"we should send Ana the photos\")",
    "a wish addressed to the assistant (\"I'd like you to...\", \"I want you to...\")",
    "a hedge (\"might be worth chasing...\", \"would be good to get ... sorted\", \"probably time we...\")",
    "a first clause of context, then the request (\"the boiler's broken again, can you call the plumber?\")",
    "a passive need (\"I need the hotel changed to a double\", \"we need the forms signed off\")",
    "a polite question (\"could you...?\", \"would you mind...?\")",
    "a terse note (\"dentist tue 3pm - book?\", \"gas bill -> pay\")",
    "a follow-up on a task (\"did you manage to book...?\", \"any luck getting ... moved?\")",
    "a request buried after chatter (\"morning! long week. anyway can you...\")",
]
LENGTHS = ["very short (1 to 5 words)", "short (5 to 10 words)", "medium (10 to 20 words)", "long (20 to 45 words)"]
STYLES = ["normal punctuation and capitals", "all lowercase, little or no punctuation", "casual with typos",
          "every message ends with a question mark, even the statements and chatter (as people sometimes do)",
          "every message ends with a full stop or '!'", "some emoji"]
AREAS = ["family", "health", "money and bills", "home and repairs", "work", "travel", "school and kids", "friends",
         "shopping", "admin and paperwork", "pets", "car", "events and parties", "subscriptions", "sport and hobbies"]
SYSTEM = "You write labelled training data. Output only a JSON array of objects, nothing else."


def prompt(lang, rnd):
    sets = []
    for i in range(8):
        sets.append(f"Set {i + 1}: area {rnd.choice(AREAS)}; length {rnd.choice(LENGTHS)}; style "
                    f"{rnd.choice(STYLES)}; act2 shape: {rnd.choice(SHAPES)}.")
    return (f"A person types messages to their AI personal assistant, which can read their email, calendar, files "
            f"and chats and can act for them. Write 8 sets of messages in {lang}, as natives really type (their "
            "names, places, currencies; not translated from English). Each set is about one concrete topic of its "
            "area, and all eight of its messages share that topic, the set's length and the set's style:\n"
            "- act1: a request for the assistant to do a task (an imperative or a plain ask).\n"
            "- act2: a request for a task, in the shape the set names.\n"
            "- act3: a very short command that leans on context (\"book it\", \"cancel it\", \"send her the link\"), "
            "or the same task in a different shape from act1 and act2.\n"
            "- qact: a question whether the user should do something (\"should I cancel...?\", \"is it worth...?\").\n"
            "- ask: a question asking only for information, nothing to be done (\"when is...?\", \"did X reply...?\").\n"
            "- chatter: small talk, thanks, a reaction, a mood, laughter.\n"
            "- intent: the user's own wish, resolution, vague plan or lack that asks the assistant for nothing "
            "(\"I need a new bed\", \"I should really drink more water\", \"we should go to Iceland one day\", "
            "\"I want to learn the guitar\"); make it sound as close to a request as you can while asking for nothing.\n"
            "- statement: news, context, an observation or a complaint that asks for nothing.\n\n"
            + "\n".join(sets)
            + '\n\nOutput: [{"topic": "...", "act1": "...", "act2": "...", "act3": "...", "qact": "...", "ask": "...", '
            '"chatter": "...", "intent": "...", "statement": "..."}, ...]')


KIND = {"act1": "act", "act2": "act", "act3": "act", "qact": "qact", "ask": "ask", "chatter": "chatter",
        "intent": "intent", "statement": "statement"}


def parse(text):
    """Every complete `{...}` set in the reply (a reply cut at its token cap keeps the sets before the cut)."""
    out = []
    for m in re.finditer(r"\{[^{}]*\}", text, re.S):
        try:
            out.append(json.loads(m.group(0)))
        except json.JSONDecodeError:
            pass
    return out


if __name__ == "__main__":
    out = sys.argv[1]
    scale = float(sys.argv[sys.argv.index("--calls-scale") + 1]) if "--calls-scale" in sys.argv else 1.0
    rnd = random.Random(int(os.environ.get("M13_GEN_SEED", "1313")))
    jobs = []
    for code, n in CALLS.items():
        for _ in range(max(1, round(n * scale))):
            jobs.append((code, prompt({**BAR, **EXTRA}[code], rnd)))
    rnd.shuffle(jobs)

    def run(job):
        code, p = job
        try:
            sets = parse(call(SYSTEM, p, run="m13-train", max_tokens=6000, think=False))
        except Exception as e:  # one failed call costs one call's rows
            print("call failed", e, file=sys.stderr)
            return []
        rows = []
        for gi, s in enumerate(sets):
            if not isinstance(s, dict):
                continue
            group = f"{code}-{abs(hash(p)) % 10**8}-{gi}"
            for key, kind in KIND.items():
                t = s.get(key)
                if isinstance(t, str) and t.strip():
                    rows.append({"text": t.strip(), "kind": kind, "lang": code, "group": group, "src": "gen"})
        return rows

    n = 0
    with open(out, "a") as f, ThreadPoolExecutor(16) as ex:
        for rows in ex.map(run, jobs):
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
                n += 1
    print(n, "rows")
