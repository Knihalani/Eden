"""M13 blind set 5 (addendum B): set 4's brief with stricter definitions, new seeds, and an English part in P2's style.
Set 4's docstring follows.

M13 blind set 4: user messages to a personal assistant in nine languages, written by Haiku from this brief alone
(no code, no rule, no training data). Held out: no M13 gate is trained or tuned on it; it is scored once per frozen
model. Kinds: act, qact (a question about whether to act), ask (a question for information), chatter, intent (a
wish, resolution or vague plan that asks for nothing), statement (news, context, a complaint), log (pasted text).

    python3 -I packages/sim/lab/m13/gen_blind4.py OUT.json
"""
import json, os, random, re, sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from haiku import call  # noqa: E402

LANGS = {"en": "English", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian", "pt": "Portuguese",
         "nl": "Dutch", "pl": "Polish", "hi": "Hindi (Devanagari script, with the English loanwords people really use)"}
KINDS = {
    "act": (60, "a request for the assistant to do a concrete task now or soon: book, pay, send, reply, cancel, "
            "order, move, remind, renew, chase, file, forward, sign up, top up, return... Mix every way people ask: "
            "plain commands; very short ones (\"cancel it\", \"book it\", \"send it now\"); polite questions (\"could "
            "you...?\"); the task as the user's own need or obligation (\"I need to pay the gas bill by Friday\", "
            "\"we have to renew the car insurance\"); suggestions (\"let's move dinner to 8\"); hedges (\"might be "
            "worth chasing the plumber\", \"would be good if you could...\"); the task after a first clause of context "
            "(\"the boiler's broken again, can you call the plumber?\"); terse notes (\"dentist tue 3pm - book?\")."),
    "qact": (20, "a question about whether the user should do something concrete (\"should I cancel the gym?\", "
             "\"is it worth renewing the warranty?\", \"do you think we should move the party to Sunday?\", \"is it "
             "OK to pay the deposit now?\")."),
    "ask": (25, "a question asking for information only, with nothing to be done: about their own life (\"when is my "
            "dentist appointment?\", \"did Tom ever reply about the tickets?\") or general knowledge (\"how long do you boil "
            "an egg?\", \"what's the capital of Peru?\"), about half each."),
    "chatter": (25, "small talk, greetings, thanks, reactions, laughter, jokes, moods, acknowledgements, one-word "
                "replies (\"thanks!\", \"haha brilliant\", \"morning, slept terribly\", \"ok sounds good\", \"yes\"). It "
                "must contain NO request, reminder or question for the assistant to act on or answer."),
    "intent": (25, "the user's own wish, resolution, vague plan or need that asks the assistant for nothing: a thing "
               "they want or lack, a habit to change, a someday idea (\"I need a new bed\", \"I really should drink "
               "more water\", \"we should go to Iceland one day\", \"I want to learn the guitar\", \"I need a "
               "holiday\", \"I have to stop buying coffee every morning\")."),
    "statement": (25, "news, context, an observation, an opinion or a complaint that asks for nothing (\"the boiler is "
                  "making that noise again\", \"Mum arrives on Friday\", \"the new manager seems nice\", \"the train "
                  "was late again\"). It must contain NO request, reminder or question for the assistant."),
}
SYSTEM = "You write realistic test data. Output only a JSON array of strings, nothing else."
PERSONAS = ["a parent of two young children", "a retired teacher", "a freelance designer", "a nurse on shifts",
            "a small shop owner", "a university student", "an engineering manager", "a landlord with two flats",
            "a carer for an elderly father", "a sales rep who travels a lot", "a doctor", "a couple planning a wedding"]


def brief(lang, kind, n, persona, seed):
    what = KINDS[kind][1]
    return (f"Write {n} different messages that {persona} might type to their AI personal assistant (which can read "
            f"their email, calendar, files and chats) in {LANGS[lang]}. Each message is {what}\n\n"
            "Write them as people really type in that language, not translated from English: their own idioms, "
            "names, places, currencies and dates. Vary everything: length from two words to three sentences (about "
            "a third very short, a third medium, a third long); some with no punctuation or capitals, some with "
            "typos, some with a question mark, some ending with '!' or '...', some with emoji. Vary the topic: "
            "family, health, money, home, work, travel, school, friends, shopping, admin. "
            f"Do not number them. (Variety seed {seed}.)")


def logs(n, seed):
    return (f"Write {n} different pieces of text a person might paste to their AI assistant with no comment: log "
            "lines, error messages, stack trace lines, CI output, shell output, a shipping tracking line, an SMS "
            "verification text, a bank alert line. Mostly English, a few in German, French or Spanish. "
            f"(Variety seed {seed}.)")


def parse(text):
    m = re.search(r"\[.*\]", text, re.S)
    try:
        return [s.strip() for s in json.loads(m.group(0)) if isinstance(s, str) and s.strip()] if m else []
    except json.JSONDecodeError:
        return []


if __name__ == "__main__":
    rnd = random.Random(5005)
    jobs = []
    for lang in LANGS:
        for kind, (n, _) in KINDS.items():
            for half in range(2):
                jobs.append((lang, kind, brief(lang, kind, n // 2 + 3, rnd.choice(PERSONAS), rnd.randrange(10**6)), n // 2))
    for k in range(3):
        jobs.append(("xx", "log", logs(15, rnd.randrange(10**6)), 14))
    # The English part in P2's style: hand-written-looking turns of a busy professional or parent.
    for kind, n in (("act", 40), ("act", 40), ("chatter", 30), ("statement", 30), ("intent", 30), ("ask", 30)):
        jobs.append(("en", kind, brief("en", kind, n + 3, rnd.choice(PERSONAS), rnd.randrange(10**6))
                     + " Make them sound like real messages from a busy person, specific names, places and amounts; for "
                     "requests, use every indirect form: a need, a hedge, a second clause after context, a passive need.", n))

    def run(job):
        lang, kind, prompt, keep = job
        return [{"kind": kind, "lang": lang, "text": t} for t in parse(call(SYSTEM, prompt, run="m13-blind5", max_tokens=6000))[:keep]]

    with ThreadPoolExecutor(8) as ex:
        rows = [r for out in ex.map(run, jobs) for r in out]
    seen, uniq = set(), []
    for r in rows:
        if r["text"].lower() not in seen:
            seen.add(r["text"].lower())
            uniq.append(r)
    json.dump(uniq, open(sys.argv[1], "w"), ensure_ascii=False, indent=0)
    print(len(uniq), "rows")
