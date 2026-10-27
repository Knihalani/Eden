"""E3 regex extractor: a literal implementation of DECISIONS D12 (strip pasted spans), D7 (slot table + patterns)
and D9 (policy / intent), with the A7 §5 action-class lexicon (+ stash, which D18 lists).
Nothing here was tuned on the E3 items beyond what the decision text says; ambiguities are resolved as noted inline."""
import re

# ---------------- D12: strip pasted spans before extraction ----------------
def strip_pasted(text):
    t = re.sub(r"<pasted_content id=[^>]*>.*?</pasted_content id=[^>]*>", "\n", text, flags=re.S)  # exact host marks
    t = re.sub(r"```.*?(```|$)", "\n", t, flags=re.S)                                              # fenced code
    lines = [l for l in t.split("\n") if not l.lstrip().startswith(">")]                            # > quotes
    # runs of >= 3 lines without sentence punctuation
    out, run = [], []
    def flush():
        if len(run) < 3:
            out.extend(run)
        run.clear()
    for l in lines:
        if l.strip() and not re.search(r"[.?!]\s*$", l.strip()):
            run.append(l)
        else:
            flush(); out.append(l)
    flush()
    return "\n".join(out).strip()   # (the ">= 200 chars also in a recent tool result" rule needs tool results; not applicable here)


# ---------------- D7 slot table ----------------
SLOTS = {  # slot: (subject_aliases, value_class)
    "auth.provider": (["auth provider", "auth", "authentication", "login provider", "login"], ["clerk", "auth0", "nextauth", "next-auth", "auth.js", "supabase auth", "cognito", "firebase auth", "lucia", "okta"]),
    "pkg.manager": (["package manager", "pkg manager"], ["pnpm", "npm", "yarn", "bun"]),
    "db.engine": (["database", "db", "db engine", "database engine"], ["postgres", "postgresql", "mysql", "sqlite", "mongodb", "mongo", "mariadb", "cockroachdb"]),
    "orm": (["orm"], ["drizzle", "prisma", "typeorm", "sequelize", "kysely", "mikro-orm"]),
    "test.runner": (["test runner", "tests", "testing", "unit tests"], ["vitest", "jest", "mocha", "playwright", "cypress", "bun test", "ava"]),
    "node.version": (["node version", "node"], r"v?\d+(\.\d+){0,2}"),
    "lang.version": (["typescript version", "ts version", "python version", "go version"], r"v?\d+(\.\d+){0,2}"),
    "framework": (["framework", "web framework"], ["next.js", "nextjs", "next", "remix", "fastify", "express", "nestjs", "hono", "react", "vue", "svelte", "sveltekit", "astro", "nuxt"]),
    "deploy.target": (["deploy target", "deploy", "deployment", "hosting", "host"], ["vercel", "fly.io", "fly", "netlify", "render", "heroku", "aws", "eks", "cloudflare", "railway", "k8s", "kubernetes"]),
    "ci.system": (["ci", "ci system"], ["github actions", "circleci", "gitlab ci", "buildkite", "jenkins", "travis"]),
    "formatter": (["formatter", "formatting"], ["prettier", "biome", "dprint"]),
    "linter": (["linter", "linting", "lint"], ["eslint", "biome", "oxlint", "tslint"]),
    "commit.style": (["commit style", "commit messages", "commits"], ["conventional commits", "gitmoji"]),
    "branch.base": (["base branch", "default branch"], ["main", "master", "develop", "trunk"]),
    "gh.account": (["github account", "gh account", "gh", "github"], []),
}
STATUS = set("broken down failing flaky slow fixed working done weird annoying wrong fine ok good bad new old".split())
NORM = {"postgresql": "postgres", "nextjs": "next.js", "next": "next.js", "mongo": "mongodb", "next-auth": "nextauth", "fly": "fly.io", "kubernetes": "k8s"}


def norm_value(v):
    v = v.strip().strip(".,;:!?'\"`").lower()
    v = re.sub(r"^v(?=\d)", "", v)
    return NORM.get(v, v)


def in_class(slot, v):
    vc = SLOTS[slot][1]
    if isinstance(vc, str):
        return re.fullmatch(vc, v) is not None
    return v in vc or norm_value(v) in {norm_value(x) for x in vc}


def ident_shaped(tok):
    return bool(re.search(r"[0-9._\-/@]", tok) or re.search(r"[a-z][A-Z]", tok) or tok[:1].isupper())


def pick_value(slot, phrase):
    """Value from a candidate phrase: a (multi-word) value_class member, else a single capitalized / identifier-shaped
    token not in the status lexicon (D7)."""
    words = re.findall(r"[A-Za-z0-9][\w.@/\-]*", phrase)
    for n in (3, 2, 1):
        for i in range(len(words) - n + 1):
            cand = " ".join(words[i:i + n])
            if in_class(slot, cand.lower()):
                return norm_value(cand)
    if len(words) >= 1:
        w = words[0] if slot != "gh.account" else next((x for x in words if re.search(r"[\-_0-9]", x)), words[0])
        if w.lower() not in STATUS and ident_shaped(w) and not isinstance(SLOTS[slot][1], str):
            return norm_value(w)
    return None


def slot_of_subject(s):
    s = s.lower().strip()
    for k, (al, _) in SLOTS.items():
        if s in al:
            return k
    return None


def slots_of_value(v):
    return [k for k in SLOTS if in_class(k, v.lower())]


ALIASES = sorted({a for al, _ in SLOTS.values() for a in al}, key=len, reverse=True)
SUBJ = "(?:" + "|".join(re.escape(a) for a in ALIASES) + ")"
VAL = r"([A-Za-z0-9][\w.@/\-]*(?: [A-Za-z0-9][\w.@/\-]*){0,2})"
P1 = re.compile(rf"(?:^|\b(?:the|our)\s+|^\W*)({SUBJ})\s+(?:is|=)\s+(?:now\s+|still\s+)?{VAL}", re.I)
P1c = re.compile(rf"(?:^|\b)({SUBJ})\s*:\s*{VAL}", re.I)
P2 = re.compile(rf"\b(?:use|using|with)\s+([\w.@/\- ]{{1,40}}?)\s+for\s+(?:the\s+|our\s+)?({SUBJ})\b", re.I)
P3 = re.compile(r"\buse\s+([\w.@/\-]+(?: [\w.@/\-]+)?)\s+(?:not|instead of|rather than)\s+([\w.@/\-]+(?: [\w.@/\-]+)?)", re.I)
P4 = re.compile(r"\bwe\s+(?:switched|moved|migrated)\s+(?:from\s+([\w.@/\-]+)\s+)?to\s+([\w.@/\-]+(?: [\w.@/\-]+)?)", re.I)
P5 = re.compile(r"^(?:and |so |but |also |btw |remember |note |fyi )*(?:we |i )?(?:always )?use\s+(.+?)(?:\s+here)?$", re.I)


def clauses(text):
    return [c.strip() for c in re.split(r"(?:[.;!?](?=\s|$))+|\n+|,\s*", text) if c.strip()]


def extract_slots(text):
    out = []
    def add(slot, op, v):
        if slot and v and (slot, op, v) not in out:
            out.append((slot, op, v))
    for c in clauses(text):
        for m in P1.finditer(c):
            k = slot_of_subject(m.group(1)); v = pick_value(k, m.group(2)) if k else None
            if k and v is None and isinstance(SLOTS[k][1], str):
                mm = re.match(r"v?\d+(\.\d+){0,2}", m.group(2)); v = norm_value(mm.group(0)) if mm else None
            add(k, "set", v)
        for m in P1c.finditer(c):
            k = slot_of_subject(m.group(1)); v = pick_value(k, m.group(2)) if k else None
            add(k, "set", v)
        for m in P2.finditer(c):
            k = slot_of_subject(m.group(2)); v = pick_value(k, m.group(1)) if k else None
            add(k, "set", v)
        for m in P3.finditer(c):
            a, b = m.group(1), m.group(2)
            ks = [k for k in SLOTS if pick_value(k, a) and in_class(k, pick_value(k, a))] or [k for k in SLOTS if in_class(k, norm_value(b.split()[0]))]
            both = [k for k in ks if in_class(k, norm_value(b.split()[0]))]  # A in several slots: the slot that also holds B
            if ks:
                k = (both or ks)[0]
                va = pick_value(k, a); vb = pick_value(k, b)
                if va and in_class(k, va): add(k, "set", va)
                if vb and in_class(k, vb): add(k, "invalidate", vb)
        for m in P4.finditer(c):
            b, a = m.group(1), m.group(2)
            ks = [k for k in SLOTS if (pa := pick_value(k, a)) and in_class(k, pa)]
            if ks:
                k = ks[0]; add(k, "set", pick_value(k, a))
                if b and pick_value(k, b) and in_class(k, pick_value(k, b)): add(k, "invalidate", pick_value(k, b))
        m = P5.match(c)
        if m and not P3.search(c):
            v = norm_value(m.group(1)); ks = slots_of_value(v)
            if len(ks) == 1:
                add(ks[0], "set", v)
    return out


# ---------------- D9 policies / intents with the A7 §5 class lexicon ----------------
CLASSES = {
    "integrate": r"\b(merg(e|es|ed|ing)|land(s|ed|ing)?|ship(s|ped|ping)?|get it in|close out|finish up|wrap up)\b",
    "review": r"\b(prs?|pull requests?|review|put up)\b",
    "complete": r"\b(done|finished|good to go|ready|all set)\b",
    "commit": r"\b(commit(s|ted|ting)?|sync)\b",
    "push-upstream": r"\b(push(es|ed|ing)?|push to (origin|remote)|upload the branch)\b",
    "branch": r"\b(branch(es)?|main|master|checkout)\b",
    "history-rewrite": r"\b(squash\w*|rebas\w*|amend\w*|force[- ]?push\w*)\b",
    "stash": r"\bstash\w*\b",
    "deploy": r"\b(deploy\w*|releas\w*|prod|publish\w*|roll(ing)? out)\b",
    "delete": r"\b(delet\w*|remov\w*|rm|clean up|prun\w*|drop\w*)\b",
    "dependency": r"\b(add(s|ed|ing)? (a |any |new )?(deps?|dependenc\w*|packages?|librar\w*)|install\w*|npm i|pnpm add|bump\w*|upgrad\w*)\b",
    "destructive-db": r"\b(drop|truncate|reset|wipe)\b.*\b(db|database|table|schema)s?\b|\bmigrate reset\b",
    "generated": r"(\bdist/|\.gen\.ts\b|\bgenerated\b)",
    "billing": r"\b(billing|invoic\w*|payments?|stripe)\b",
}
# precedence when several classes match in one clause: the more specific / more severe class wins
ORDER = ["destructive-db", "history-rewrite", "stash", "generated", "billing", "dependency", "deploy", "delete", "push-upstream",
         "integrate", "review", "commit", "branch", "complete"]
RX = {k: re.compile(v, re.I) for k, v in CLASSES.items()}
TRIG = re.compile(r"\b(don'?t|do not|never|always|without asking|ask before|only after)\b", re.I)
QUAL = re.compile(r"\b(yet|for now|until|before|after|this time|in this pr)\b", re.I)
QMAP = {"yet": "yet", "for now": "for-now", "until": "until", "before": "before", "after": "after", "this time": "this-time", "in this pr": "in-this-pr"}
OBJ = [(r"\b(prs?|pull requests?)\b", "pr"), (r"\b(main|master)\b", "main"), (r"\bmigrations?\b", "migrations"), (r"\.env\b", ".env"),
       (r"\b(prod|production)\b", "prod"), (r"\bdist/?", "dist"), (r"\bbranch(es)?\b", "branch"), (r"\btables?\b", "table"),
       (r"\b(db|database)\b", "db"), (r"\b(origin|remote|upstream)\b", "remote"), (r"\bcommits?\b", "commit")]


def extract_rules(text):
    out = []
    for sent in re.split(r"(?:[.;!?](?=\s|$))+|\n+", text):
        qsent = TRIG.sub(" ", sent)  # a trigger's own "before"/"after" ("ask before", "only after") is not a qualifier
        for c in re.split(r",\s*", sent):
            trigs = list(TRIG.finditer(c))
            for j, m in enumerate(trigs):
                trig = m.group(1).lower()
                # "always ask before X": the later, more specific trigger governs
                if trig == "always" and j + 1 < len(trigs) and trigs[j + 1].start() - m.end() <= 1:
                    continue
                window = c[:m.start()] + " " + c[m.end():] if trig == "without asking" else c[m.end():]
                hits = [k for k in ORDER if RX[k].search(window)]
                if not hits:
                    continue
                cls = hits[0]
                pol = "pos" if trig == "always" else "neg"
                q = QUAL.search(qsent)
                cm = RX[cls].search(window)
                scope = QUAL.split(window[cm.start():])[0] if cm else window  # objects come before any qualifier phrase
                best = None
                for rx, name in OBJ:
                    if (name == "branch" and cls == "branch") or (name == "commit" and cls == "commit"):
                        continue
                    mo = re.search(rx, scope, re.I)
                    if mo and (best is None or mo.start() < best[0]):
                        best = (mo.start(), name)
                obj = best[1] if best else "*"
                kind = "intent" if q else "policy"
                rec = (kind, cls, pol, obj, QMAP[q.group(1).lower()] if q else None)
                if rec not in out:
                    out.append(rec)
                break  # one rule per clause
    return out


def extract(text):
    t = strip_pasted(text)
    ex = [dict(kind="slot", slot=s, op=op, value=v) for s, op, v in extract_slots(t)]
    ex += [dict(kind=k, cls=c, pol=p, obj=o, qual=q) for k, c, p, o, q in extract_rules(t)]
    return ex


if __name__ == "__main__":
    import sys
    for s in sys.argv[1:]:
        print(s, "->", extract(s))
