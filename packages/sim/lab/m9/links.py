"""M9 (D950-D959, docs/research/m9-alias.md): per-user link structures learned from one user's own items, and the
request-time resolver that expands a request through them. Python reference for the hypotheses screen (screen.py);
the TypeScript port is what ships if anything does.

Every structure here is built from ONE user's items (no pooling across users). The only shared resource is the
gazetteer (place -> country), general knowledge, not learned from any user.
"""
import math
import re
import unicodedata
from collections import Counter, defaultdict

STOP = set("""a an the and or but if of for to in on at by with from into onto as is are was were be been being it its
this that these those i me my we our us you your he she they them their his her him not no do does did done can could
would should will shall may might must have has had having so than then there here up out over under about after before
again any all each both few more most other some such only own same too very just also please thanks thank hi hello dear
regards best let know what which who whom when where why how am pm re fwd fw via per cc bcc sent today tomorrow yesterday
week weeks next last this day days month months year years morning afternoon evening night monday tuesday wednesday
thursday friday saturday sunday mon tue wed thu fri sat sun jan feb mar apr may jun jul aug sep sept oct nov dec january
february march april june july august september october november december get got go going make made take one two
i'm i'll i've it's don't can't won't didn't isn't that's we're we'll you're they're there's let's okay ok yes
send book pay sign tell ask email message reply set put add order buy find arrange organise schedule""".split())

DIMINUTIVE = {  # nickname -> full first names (general English usage, not learned from users)
    "bob": ["robert"], "rob": ["robert", "robin"], "bill": ["william"], "will": ["william"], "liz": ["elizabeth"],
    "beth": ["elizabeth", "bethany"], "kate": ["katherine", "catherine", "kathryn"], "katie": ["katherine", "catherine"],
    "jen": ["jennifer"], "jenny": ["jennifer"], "dan": ["daniel"], "danny": ["daniel"], "mike": ["michael"],
    "mick": ["michael"], "tom": ["thomas"], "tommy": ["thomas"], "jim": ["james"], "jimmy": ["james"],
    "jamie": ["james"], "dave": ["david"], "chris": ["christopher", "christine", "christina"], "sam": ["samuel",
    "samantha"], "alex": ["alexander", "alexandra"], "nick": ["nicholas"], "matt": ["matthew"], "andy": ["andrew"],
    "drew": ["andrew"], "tony": ["anthony"], "steve": ["stephen", "steven"], "joe": ["joseph"], "ben": ["benjamin"],
    "fred": ["frederick"], "ed": ["edward"], "eddie": ["edward"], "ted": ["edward"], "pete": ["peter"],
    "rick": ["richard"], "rich": ["richard"], "dick": ["richard"], "greg": ["gregory"], "jon": ["jonathan"],
    "jonny": ["jonathan"], "nat": ["natalie", "nathan", "nathaniel"], "pat": ["patrick", "patricia"],
    "vicky": ["victoria"], "becky": ["rebecca"], "becca": ["rebecca"], "sue": ["susan"], "maggie": ["margaret"],
    "meg": ["margaret", "megan"], "abby": ["abigail"], "gabe": ["gabriel"], "gabi": ["gabriela", "gabrielle"],
    "nico": ["nicolas", "nicola"], "ollie": ["oliver"], "olly": ["oliver"], "charlie": ["charles", "charlotte"],
    "harry": ["henry", "harold"], "hal": ["henry"], "josh": ["joshua"], "zach": ["zachary"], "zac": ["zachary"],
    "max": ["maximilian", "maxwell"], "jo": ["joanna", "josephine", "joanne"], "fran": ["francesca", "frances"],
    "frankie": ["francesca", "frances"], "tash": ["natasha"], "sasha": ["alexandra", "alexander"],
    "lexi": ["alexandra"], "izzy": ["isabel", "isabella"], "bella": ["isabella"], "ellie": ["eleanor", "elena"],
    "nell": ["eleanor"], "theo": ["theodore"], "freddie": ["frederick"], "alfie": ["alfred"], "archie": ["archibald"],
    "mo": ["mohammed", "muhammad", "maureen"], "tomás": ["tomas"], "kai": ["kaiden"], "gill": ["gillian"],
}

ROLES = set("""mum mom mother mam mummy dad father daddy grandma gran granny nan nana grandad grandpa grandfather
grandmother sister brother sis bro wife husband partner son daughter aunt auntie uncle cousin niece nephew in-law
mother-in-law father-in-law stepmum stepdad landlord landlady letting agent tenant lodger flatmate housemate neighbour
neighbours neighbor babysitter sitter nanny childminder au-pair cleaner gardener handyman plumber electrician sparky
builder decorator roofer locksmith mechanic accountant solicitor lawyer advisor adviser broker agent tutor teacher
headteacher head coach instructor trainer gp doctor dentist nurse physio therapist vet pharmacist optician midwife
health-visitor carer manager boss ceo cfo coo cto cio ciso gc dpo vp director head lead approver reviewer owner
assistant pa ea secretary recruiter hr payroll finance procurement legal counsel it helpdesk security admin
on-call oncall primary secondary rota sponsor champion buddy mentor mentee intern contractor consultant vendor
supplier reseller partner customer client account rep ae csm am sdr founder chair chairman treasurer""".split())

RULE_CUES = re.compile(
    r"\b(must|mustn't|must not|need(?:s)? (?:to|my|our|a|an|the)?|needs|required|requires|only|not allowed|no longer|"
    r"don't|do not|please don't|can't|cannot|won't|isn't|aren't|not|never|until|before|without|unless|over|above|"
    r"limit|cap|capped|frozen|freeze|paused|pause|hold|blocked|bar|bars|exclusive|policy|rule|approval|approve|"
    r"sign-off|signoff|pre-approval|already|cancel|cancelled|away|off|closed|unavailable|not free|instead|moved)\b")


def fold(s):
    s = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in s if not unicodedata.combining(c))


WORD = re.compile(r"[a-z0-9]+(?:[-'][a-z0-9]+)*")


def toks(s):
    return WORD.findall(fold(s).replace("’", "'"))


def stem(t):
    # A light suffix strip so "pipes"/"pipe", "plumber"/"plumbers" meet; good enough for the screen.
    for suf in ("ies", "es", "s"):
        if len(t) > 4 and t.endswith(suf) and not t.endswith("ss"):
            return t[: -len(suf)] + ("y" if suf == "ies" else "")
    return t


def content(s):
    return [stem(t) for t in toks(s) if t not in STOP and len(t) > 1 and not t.isdigit()]


NAME = re.compile(r"\b([A-Z][a-zà-ÿ'’-]+(?:\s+[A-Z][a-zà-ÿ'’-]+){0,2})\b")
FROM = re.compile(r"^(From|To|Cc): (.+)$", re.M)
ADDR = re.compile(r"([^<,]+?)\s*<([^>@\s]+)@([^>\s]+)>")
SLACK = re.compile(r"^\[\d\d:\d\d\] ([^:\n]{2,40}):", re.M)
CRM_CONTACT = re.compile(r"^Contact: (.+)$", re.M)
CRM_COMPANY = re.compile(r"^Company: (.+)$", re.M)
CRM_TITLE = re.compile(r"^Title: (.+)$", re.M)
CRM_ACCOUNT = re.compile(r"^Account: (.+)$", re.M)
CRM_DOMAIN = re.compile(r"^Domain: (.+)$", re.M)
SIG = re.compile(r"-- ([A-Z][^\n|]{2,40}?) ([A-Z][A-Za-z &/-]{1,40}) \| ([A-Z][A-Za-z0-9 &'.-]{1,40}?)(?: M:| T:| \+|$| --)")
ATTEND = re.compile(r"^Attendees: (.+)$", re.M)


def body(it):
    t = it["text"]
    i = t.find("\n\n")
    return t[i + 2:] if i >= 0 and t.startswith("From:") else t


class User:
    """One user's link state, built from their items only (at ingest, item by item)."""

    def __init__(self, items, home="gb"):
        self.items = items
        self.people = {}  # full name (folded) -> {"first", "orgs": Counter, "emails": set}
        self.org_people = defaultdict(set)
        self.domain_org = {}
        self.df = Counter()
        self.n = 0
        self.tf = {}
        self.inv = defaultdict(list)
        self.role_person = defaultdict(Counter)  # role -> person -> co-occurrence count
        self.person_items = defaultdict(set)
        self.role_df = Counter()
        self.cooc = defaultdict(Counter)  # term -> term -> item co-occurrence (sampled)
        self.rule_items = set()
        self.home = home
        for it in items.values():
            self.ingest(it)

    # ---- ingest ----
    def person(self, name, email=None, org=None):
        name = " ".join(name.replace('"', "").split())
        if not NAME.fullmatch(name) or len(name.split()) < 2:
            return None
        k = fold(name)
        p = self.people.setdefault(k, {"name": name, "first": fold(name.split()[0]), "orgs": Counter(),
                                       "emails": set()})
        if email:
            p["emails"].add(email)
        if org:
            p["orgs"][org] += 1
            self.org_people[fold(org)].add(k)
        return k

    def ingest(self, it):
        iid, t = it["id"], it["text"]
        full = f"{it['title']}\n{t}"
        terms = content(full)
        c = Counter(terms)
        self.tf[iid] = (c, len(terms))
        for w in c:
            self.df[w] += 1
            self.inv[w].append(iid)
        self.n += 1
        found = set()
        if iid.startswith("crm:contact"):
            nm = CRM_CONTACT.search(t)
            co = CRM_COMPANY.search(t)
            ti = CRM_TITLE.search(t)
            if nm:
                k = self.person(nm.group(1), org=co.group(1).strip() if co else None)
                if k and ti:
                    for r in toks(ti.group(1)):
                        if r in ROLES:
                            self.role_person[r][k] += 3
                found.add(k)
        if iid.startswith("crm:deal"):
            a, d = CRM_ACCOUNT.search(t), CRM_DOMAIN.search(t)
            if a and d:
                self.domain_org[d.group(1).strip().lower()] = a.group(1).strip()
        for m in FROM.finditer(t):
            for a in ADDR.finditer(m.group(2)):
                nm, local, dom = a.group(1).strip(), a.group(2), a.group(3).lower()
                found.add(self.person(nm, email=f"{local}@{dom}"))
        for m in SLACK.finditer(t):
            found.add(self.person(m.group(1)))
        for m in SIG.finditer(t):
            k = self.person(m.group(1).strip(), org=m.group(3).strip())
            if k:
                for r in toks(m.group(2)):
                    if r in ROLES:
                        self.role_person[r][k] += 3
                found.add(k)
        for m in ATTEND.finditer(t):
            for nm in m.group(1).split(","):
                found.add(self.person(nm.strip()))
        # Names written in the body.
        for m in NAME.finditer(body(it)):
            k = fold(m.group(1))
            if k in self.people:
                found.add(k)
        found.discard(None)
        for k in found:
            self.person_items[k].add(iid)
        # Roles: a role word in the same sentence as a person's name (or first name) -> evidence for the link.
        low = fold(full)
        for sent in re.split(r"(?<=[.!?\n])\s+", full):
            st = set(toks(sent))
            rs = [r for r in st if r in ROLES]
            if not rs:
                continue
            for r in rs:
                self.role_df[r] += 1
            for k in self.people:
                p = self.people[k]
                if p["first"] in st:
                    for r in rs:
                        self.role_person[r][k] += 1
        if RULE_CUES.search(low):
            self.rule_items.add(iid)

    def link_domains(self):
        """email domain -> org name: an org whose folded words, joined, begin the domain ('piedpiper.com')."""
        orgs = set(self.org_people) | {fold(o) for o in self.domain_org.values()}
        for p in self.people.values():
            for e in p["emails"]:
                dom = e.split("@")[1]
                stemd = re.sub(r"[^a-z]", "", dom.split(".")[0])
                o = self.domain_org.get(dom)
                if not o:
                    for org in orgs:
                        if len(org) > 3 and re.sub(r"[^a-z]", "", org) == stemd:
                            o = org
                if o:
                    p["orgs"][o] += 1
                    self.org_people[fold(o)].add(fold(p["name"]))

    # ---- request ----
    def idf(self, w):
        return math.log(1 + (self.n - self.df[w] + 0.5) / (self.df[w] + 0.5))

    def bm25(self, terms, k1=1.2, b=0.75, avg=60.0):
        sc = defaultdict(float)
        for w, qw in terms.items():
            if w not in self.df:
                continue
            idf = self.idf(w)
            for iid in self.inv[w]:
                c, ln = self.tf[iid]
                f = c[w]
                sc[iid] += qw * idf * f * (k1 + 1) / (f + k1 * (1 - b + b * ln / avg))
        return sc
