"""M13 round 3 training additions (addendum B): the turn types round 2 missed, in the nine bar languages, written by
Haiku from this brief (a different brief from S5's, which is never read here).

    python3 -I packages/sim/lab/m13/gen_extra.py OUT.jsonl
"""
import json, os, random, re, sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from haiku import call  # noqa: E402
from gen_train import BAR  # noqa: E402

CATS = {
    "ask": "questions asking for general knowledge or a fact about the world, nothing to be done (cooking times, "
           "history, science, health, geography, how something works, word meanings, sports rules)",
    "chatter-ack": "bare replies and acknowledgements of one to four words (yes, no, ok, got it, sure, perfect, "
                   "cool thanks, sounds good, nope, done, will do, fair enough)",
    "chatter-retract": "retractions and corrections that ask for nothing (never mind, ignore that, wrong chat, "
                       "disregard my last message, sorry typo, scratch that, forget I asked)",
    "chatter-social": "social questions or remarks to the assistant that ask nothing to be done or looked up (how "
                      "are you?, did you have a good weekend?, will you be home for dinner? said by mistake, are you "
                      "a robot?, you're funny, can you believe this weather?)",
    "intent": "wanting or lacking a thing, or a vague plan, with no task for the assistant (I need a new bed, we "
              "need a bigger kitchen, I could do with a holiday, we should get a dog one day, I need to sleep more)",
    "act": "concrete tasks phrased as the user's own need, stop or change (I need to stop paying for Netflix, we need "
           "the oven fixed before Friday, I have to cancel the gym this month, the bed needs returning to IKEA by "
           "Sunday, I need the Dublin hotel changed to a double)",
}
# Round 4 (D1014's review): the turns the shipped gate started though they ask nothing.
SHORT = {
    "chatter-greet": "greetings and openers of one to three words, often lowercase with no punctuation (hello, hi, "
                     "hello there, hey you, morning, good evening, hi all, hallo zusammen, ciao a tutti, salut)",
    "chatter-noise": "throwaway inputs of one to three characters or words: a lone '?', '...', 'hmm', 'asdf', 'test', "
                     "a single letter, a single emoji, 'm0', 'x2', a keyboard mash, 'ping', 'you there'",
}
KIND = {"chatter-greet": "chatter", "chatter-noise": "chatter", "ask": "ask", "chatter-ack": "chatter", "chatter-retract": "chatter", "chatter-social": "chatter",
        "intent": "intent", "act": "act"}

if __name__ == "__main__":
    rnd = random.Random(7171)
    short = "--short" in sys.argv
    if short:
        CATS.clear()
        CATS.update(SHORT)
        rnd = random.Random(8282)
    jobs = [(L, c, rnd.randrange(10**6)) for L in BAR for c in CATS for _ in range(2 if L != "en" else 4)]

    def run(job):
        L, c, seed = job
        t = call("Output only a JSON array of strings.", f"Write 40 different messages a person might type to their "
                 f"AI personal assistant in {BAR[L]}, as natives really type (mixed lengths, some lowercase or "
                 f"unpunctuated, some with typos): {CATS[c]}. Seed {seed}.", run="m13-extra", max_tokens=4000,
                 think=False)
        m = re.search(r"\[.*\]", t, re.S)
        try:
            xs = [x for x in json.loads(m.group(0)) if isinstance(x, str)] if m else []
        except json.JSONDecodeError:
            xs = []
        return [{"text": x.strip(), "kind": KIND[c], "lang": L, "group": f"extra-{L}-{c}-{seed}", "src": "genx:" + c}
                for x in xs if x.strip()]

    with ThreadPoolExecutor(12) as ex, open(sys.argv[1], "w") as f:  # OUT.jsonl [--short]
        for rows in ex.map(run, jobs):
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
