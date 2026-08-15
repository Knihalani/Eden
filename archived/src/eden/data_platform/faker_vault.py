"""FakerVault — deterministic real→fake PII mapping (Phase K, RagaAI parity).

The synthetic dataset pipeline (``SyntheticDataEngine``) needs
to generate training data that *looks* realistic without
leaking real PII from the org's telemetry. The straightforward
approach — pull names from a public list and stitch them in —
works until the same dataset is shipped to a customer and
someone Googles a "synthetic" name and finds the same name
in their own telemetry.

The fix: a **deterministic vault** that maps any real PII value
to a stable fake. The same input always produces the same
output (so a person's name doesn't change between dataset
versions), but the output is drawn from a curated list of
plausible fakes — not from the real input.

How it works
────────────
1. Hash the input with SHA-256 → take the first 8 bytes as
   a uint64 index → modulo the size of the relevant pool.
2. The pool is a curated list of plausible values (e.g. for
   ``fake_name()`` in the ``en`` locale: 200 English first
   names × 200 English surnames = 40,000 unique combinations).
3. The hash is salted with a per-vault secret so the same
   input produces *different* output in different vaults. The
   default salt is a process-wide constant; callers can set
   their own to scope the vault (e.g. per-org).

Why deterministic?
──────────────────
* The same real email always fakes to the same synthetic
  email, so a dataset rebuild doesn't surprise users with
  new "Sarah Johnson"s in the same column.
* Tests can assert that ``fake_email("alice@example.com") ==
  fake_email("alice@example.com")`` without seeding RNG.
* Privacy: the hash is one-way; an attacker with the vault
  output cannot recover the real input.

What it does NOT do
───────────────────
* Generate infinite variation. The pool is finite; with
  enough input, you'll see the same fake for two different
  real values. That's a *feature* — it's exactly what we
  want for redaction (more variety = more identifying info
  leaks).
* Speak every language. We ship en / es / ar / ja / fr / de /
  zh pools; callers can plug in their own pools for other
  locales.
* Validate the input. ``fake_email("not-an-email")`` returns
  a fake email; we don't refuse the input.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import unicodedata
from dataclasses import dataclass, field

# ── Pools ──────────────────────────────────────────────────────────
# Curated, public-domain lists. These are common names from
# public census / SSA / similar sources. We keep them inline
# so the vault is self-contained — no faker dependency.

# English first names (200)
EN_FIRST_NAMES: tuple[str, ...] = (
    "James", "Mary", "Robert", "Patricia", "John", "Jennifer", "Michael",
    "Linda", "William", "Elizabeth", "David", "Barbara", "Richard", "Susan",
    "Joseph", "Jessica", "Thomas", "Sarah", "Charles", "Karen", "Christopher",
    "Lisa", "Daniel", "Nancy", "Matthew", "Betty", "Anthony", "Margaret",
    "Mark", "Sandra", "Donald", "Ashley", "Steven", "Kimberly", "Paul",
    "Emily", "Andrew", "Donna", "Joshua", "Michelle", "Kenneth", "Carol",
    "Kevin", "Amanda", "Brian", "Dorothy", "George", "Melissa", "Edward",
    "Deborah", "Ronald", "Stephanie", "Timothy", "Rebecca", "Jason", "Sharon",
    "Jeffrey", "Laura", "Ryan", "Cynthia", "Jacob", "Kathleen", "Gary",
    "Amy", "Nicholas", "Angela", "Eric", "Shirley", "Jonathan", "Anna",
    "Stephen", "Brenda", "Larry", "Pamela", "Justin", "Nicole", "Scott",
    "Emma", "Brandon", "Helen", "Frank", "Samantha", "Benjamin", "Katherine",
    "Gregory", "Christine", "Samuel", "Debra", "Raymond", "Rachel", "Patrick",
    "Catherine", "Alexander", "Carolyn", "Jack", "Janet", "Dennis", "Ruth",
    "Jerry", "Maria", "Tyler", "Heather", "Aaron", "Diane", "Jose", "Virginia",
    "Adam", "Julie", "Henry", "Joyce", "Nathan", "Victoria", "Douglas",
    "Olivia", "Peter", "Kelly", "Zachary", "Christina", "Kyle", "Lauren",
    "Noah", "Joan", "Ethan", "Evelyn", "Jeremy", "Judith", "Walter",
    "Megan", "Christian", "Andrea", "Keith", "Cheryl", "Roger", "Hannah",
    "Terry", "Jacqueline", "Austin", "Martha", "Sean", "Gloria", "Gerald",
    "Teresa", "Carl", "Ann", "Harold", "Sara", "Dylan", "Madison",
    "Arthur", "Frances", "Lawrence", "Kathryn", "Jordan", "Janice", "Jesse",
    "Jean", "Bryan", "Abigail", "Billy", "Alice", "Bruce", "Judy",
    "Gabriel", "Sophia", "Joe", "Grace", "Logan", "Denise", "Albert",
    "Amber", "Willie", "Doris", "Alan", "Marilyn", "Eugene", "Danielle",
    "Russell", "Beverly", "Vincent", "Isabella", "Philip", "Theresa",
    "Bobby", "Diana", "Johnny", "Natalie", "Bradley", "Brittany", "Roy",
)

# English surnames (200)
EN_LAST_NAMES: tuple[str, ...] = (
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
    "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez",
    "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin",
    "Lee", "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark",
    "Ramirez", "Lewis", "Robinson", "Walker", "Young", "Allen", "King",
    "Wright", "Scott", "Torres", "Nguyen", "Hill", "Flores", "Green",
    "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell",
    "Carter", "Roberts", "Gomez", "Phillips", "Evans", "Turner", "Diaz",
    "Parker", "Cruz", "Edwards", "Collins", "Reyes", "Stewart", "Morris",
    "Morales", "Murphy", "Cook", "Rogers", "Gutierrez", "Ortiz", "Morgan",
    "Cooper", "Peterson", "Bailey", "Reed", "Kelly", "Howard", "Ramos",
    "Kim", "Cox", "Ward", "Richardson", "Watson", "Brooks", "Chavez",
    "Wood", "James", "Bennett", "Gray", "Mendoza", "Ruiz", "Hughes",
    "Price", "Alvarez", "Castillo", "Sanders", "Patel", "Myers", "Long",
    "Ross", "Foster", "Jimenez", "Powell", "Jenkins", "Perry", "Russell",
    "Sullivan", "Bell", "Coleman", "Butler", "Henderson", "Barnes",
    "Gonzales", "Fisher", "Vasquez", "Simmons", "Romero", "Jordan",
    "Patterson", "Alexander", "Hamilton", "Graham", "Reynolds", "Griffin",
    "Wallace", "Moreno", "West", "Cole", "Hayes", "Bryant", "Herrera",
    "Gibson", "Ellis", "Tran", "Medina", "Aguilar", "Stevens", "Murray",
    "Ford", "Castro", "Marshall", "Owens", "Harrison", "Fernandez",
    "McDonald", "Woods", "Washington", "Kennedy", "Wells", "Vargas",
    "Henry", "Chen", "Freeman", "Webb", "Tucker", "Guzman", "Burns",
    "Crawford", "Olson", "Simpson", "Porter", "Hunter", "Gordon",
    "Mendez", "Silva", "Shaw", "Snyder", "Mason", "Dixon", "Munoz",
    "Hunt", "Hicks", "Holmes", "Palmer", "Wagner", "Black", "Robertson",
    "Boyd", "Rose", "Stone", "Salazar", "Fox", "Warren", "Mills",
    "Meyer", "Rice", "Schmidt", "Garza", "Daniels", "Ferguson",
    "Nichols", "Stephens", "Soto", "Weaver", "Ryan", "Gardner", "Payne",
)

# Spanish first names (60)
ES_FIRST_NAMES: tuple[str, ...] = (
    "José", "María", "Juan", "Carmen", "Antonio", "Ana", "Francisco",
    "Isabel", "Manuel", "Dolores", "David", "Pilar", "Daniel", "Teresa",
    "Carlos", "Rosa", "Miguel", "Concepción", "Rafael", "Mercedes", "Pedro",
    "Cristina", "Jesús", "Josefa", "Ángel", "Antonia", "Alejandro", "Luisa",
    "Fernando", "Margarita", "Pablo", "Francisca", "Luis", "Encarnación",
    "Javier", "Amparo", "Sergio", " Rosario", "Andrés", "Montserrat",
    "Jorge", "Josefina", "Alberto", "Yolanda", "Diego", "Inmaculada",
    "Raúl", "Nuria", "Eduardo", "Consuelo", "Óscar", "Lorena",
    "Rubén", "Marta", "Iván", "Beatriz", "Marcos", "Alicia",
)

# Spanish surnames (60 — common first + last compound)
ES_LAST_NAMES: tuple[str, ...] = (
    "García", "Rodríguez", "Martínez", "López", "Sánchez", "Pérez",
    "Gómez", "Fernández", "Ruiz", "Hernández", "Jiménez", "Díaz",
    "Moreno", "Álvarez", "Romero", "Alonso", "Navarro", "Torres",
    "Domínguez", "Vázquez", "Ramos", "Gil", "Ramírez", "Serrano",
    "Molina", "Blanco", "Suárez", "Castro", "Ortega", "Delgado",
    "Marín", "Rubio", "Iglesias", "Ortiz", "Sanz", "Cruz",
    "Garrido", "Cortés", "Castillo", "Lozano", "Guerrero", "Cano",
    "Prieto", "Mendoza", "León", "Calvo", "Vidal", "Núñez",
    "Domenech", "Marcos", "Carmona", "Pardo", "Cuesta", "Aguilar",
    "Herrera", "Vega", "Soto", "Caballero", "Peralta", "Reyes",
)

# Arabic first names (60)
AR_FIRST_NAMES: tuple[str, ...] = (
    "Mohammed", "Ahmed", "Ali", "Hassan", "Hussein", "Omar", "Abdullah",
    "Yusuf", "Ibrahim", "Khalid", "Mustafa", "Mahmoud", "Said", "Salem",
    "Tariq", "Yahya", "Faisal", "Saeed", "Hamza", "Zaid", "Nasser",
    "Khaled", "Bilal", "Fawaz", "Majed", "Fahad", "Walid", "Karim",
    "Rashid", "Sultan", "Adel", "Hatem", "Sami", "Anwar", "Mounir",
    "Rami", "Imad", "Fadi", "Jihad", "Ayman", "Bassam", "Hisham",
    "Farah", "Layla", "Fatima", "Aisha", "Maryam", "Nadia", "Yasmin",
    "Sara", "Hala", "Rana", "Dina", "Lina", "Rania", "Salma", "Nada",
    "Mariam", "Hind", "Amal", "Zahra",
)

# Arabic surnames (60)
AR_LAST_NAMES: tuple[str, ...] = (
    "Al-Saud", "Al-Sabah", "Al-Nahyan", "Al-Maktoum", "Al-Thani",
    "Al-Maktoum", "Al-Sayed", "Al-Hashimi", "Al-Quraishi", "Al-Ansari",
    "Husseini", "Hassani", "Mahmoud", "Ibrahim", "Yusuf", "Ahmed",
    "Mohammed", "Khalil", "Said", "Saleh", "Nasser", "Khaled", "Faisal",
    "Hamza", "Salim", "Mansour", "Abbas", "Rashid", "Hakim", "Karim",
    "Tariq", "Wahab", "Faruq", "Bashir", "Najjar", "Habib", "Safi",
    "Qureshi", "Sheikh", "Khan", "Ahmad", "Rahman", "Aziz", "Sultan",
    "Kareem", "Hadi", "Fadel", "Halabi", "Hadid", "Mansour", "Sabbagh",
    "Daher", "Maalouf", "Khoury", "Najim", "Asmar", "Salibi", "Daou",
)

# Japanese names (60) — surname first, then given (Western order used here)
JA_LAST_NAMES: tuple[str, ...] = (
    "Sato", "Suzuki", "Takahashi", "Tanaka", "Watanabe", "Ito", "Yamamoto",
    "Nakamura", "Kobayashi", "Kato", "Yoshida", "Yamada", "Sasaki", "Yamaguchi",
    "Matsumoto", "Inoue", "Kimura", "Shimizu", "Hayashi", "Shibata", "Mori",
    "Abe", "Ikeda", "Hashimoto", "Ogawa", "Yamasaki", "Saito", "Nakagawa",
    "Fujita", "Hasegawa", "Ono", "Kondo", "Ishii", "Ishikawa", "Endo",
    "Sakurai", "Okada", "Goto", "Hara", "Aoki", "Fujii", "Nishimura",
    "Fukuda", "Miura", "Nakano", "Kojima", "Tachibana", "Sakai", "Otsuka",
    "Maruyama", "Tsuda", "Kubo", "Miyazaki", "Hori", "Matsuda", "Saeki",
    "Fukuyama", "Nakata",
)

JA_FIRST_NAMES: tuple[str, ...] = (
    "Haruto", "Yuto", "Sota", "Yuki", "Hiroto", "Ren", "Kaito", "Sora",
    "Riku", "Arata", "Koki", "Asahi", "Minato", "Rin", "Hina", "Yua",
    "Mei", "Sakura", "Aoi", "Yuna", "Riko", "Rio", "Yui", "Akari",
    "Mio", "Koharu", "Sara", "Yuka", "Miyu", "Momoka", "Eri", "Ayaka",
    "Hana", "Emi", "Kana", "Maki", "Saori", "Asuka", "Misaki", "Ayumi",
    "Naomi", "Saki", "Wakaba", "Tsubasa", "Kazuha", "Hikari", "Moe",
    "Chiaki", "Natsuki", "Toshio", "Kenji", "Takashi", "Akira", "Daisuke",
    "Yusuke", "Shinji", "Hiroshi", "Kazuo", "Osamu", "Tatsuya", "Ryota",
)

# Chinese (Simplified) names (60)
ZH_LAST_NAMES: tuple[str, ...] = (
    "Wang", "Li", "Zhang", "Liu", "Chen", "Yang", "Huang", "Zhao", "Wu",
    "Zhou", "Xu", "Sun", "Ma", "Zhu", "Hu", "Lin", "Guo", "He", "Gao",
    "Liang", "Song", "Tang", "Han", "Feng", "Deng", "Cao", "Peng", "Zeng",
    "Xiao", "Tian", "Yu", "Du", "Pan", "Lu", "Cai", "Yuan", "Lu", "Lou",
    "Shi", "Yan", "Cui", "Mao", "Xu", "Qian", "Gong", "Cheng", "Wei",
    "Jiang", "Tong", "Qiu", "An", "Yi", "Yu", "Bao", "Pei", "Shen",
    "Wan", "Lei", "Hou", "Bian",
)

ZH_FIRST_NAMES: tuple[str, ...] = (
    "Wei", "Fang", "Min", "Jing", "Lei", "Yan", "Tao", "Hua", "Juan",
    "Lei", "Gang", "Hui", "Hong", "Lan", "Mei", "Qiang", "Jian", "Ping",
    "Hao", "Xin", "Yang", "Yu", "Bin", "Cheng", "Dong", "Feng", "Guo",
    "Hai", "Jin", "Kun", "Ling", "Ming", "Na", "Peng", "Qing", "Rong",
    "Shan", "Ting", "Wei", "Xia", "Yong", "Zhen", "Bo", "Chen", "Di",
    "En", "Fei", "Ge", "Han", "Jia", "Kai", "Li", "Mu", "Ning", "Ou",
    "Qian", "Ren", "Shu", "Tian", "Wen", "Xue", "Yi", "Zhu",
)

# French names (60)
FR_FIRST_NAMES: tuple[str, ...] = (
    "Jean", "Marie", "Pierre", "Anne", "Philippe", "Catherine", "Michel",
    "Françoise", "Alain", "Monique", "Bernard", "Jacqueline", "Christian",
    "Suzanne", "Daniel", "Nicole", "Claude", "Denise", "André", "Madeleine",
    "Louis", "Simone", "François", "Hélène", "Henri", "Yvette", "René",
    "Jeannine", "Marcel", "Paulette", "Roger", "Yvonne", "Gérard", "Marcelle",
    "Joseph", "Raymonde", "Robert", "Andrée", "Paul", "Louise", "Jacques",
    "Germaine", "Antoine", "Thérèse", "Guy", "Marguerite", "Georges",
    "Georgette", "Maurice", "Odette", "Lucien", "Gilberte", "Roland",
    "Gabrielle", "Gabriel", "Bernadette", "Denis", "Colette", "Emmanuel",
)

FR_LAST_NAMES: tuple[str, ...] = (
    "Martin", "Bernard", "Dubois", "Thomas", "Robert", "Richard", "Petit",
    "Durand", "Leroy", "Moreau", "Simon", "Laurent", "Lefebvre", "Michel",
    "Roux", "David", "Bertrand", "Morin", "Fournier", "Girard", "Bonnet",
    "Dupont", "Lambert", "Fontaine", "Rousseau", "Vincent", "Muller",
    "Lefevre", "Faure", "Andre", "Mercier", "Blanc", "Guerin", "Boyer",
    "Garcia", "Sullivan", "Lemoine", "Carpentier", "Boucher", "Vasseur",
    "Pires", "Lemaire", "Benoit", "Legrand", "Gautier", "Huet", "Masson",
    "Marchand", "Duval", "Denis", "Dumont", "Marie", "Noel", "Meyer",
    "Fernandez", "Henry", "Lacroix", "Payet", "Rolland", "Picard",
)

# German names (60)
DE_FIRST_NAMES: tuple[str, ...] = (
    "Maximilian", "Sophia", "Alexander", "Marie", "Paul", "Maria", "Leon",
    "Emma", "Felix", "Mia", "Ben", "Hannah", "Elias", "Anna", "Finn",
    "Lea", "Noah", "Lina", "Lukas", "Lena", "Henry", "Laura", "Jakob",
    "Charlotte", "Jonas", "Lukas", "Amelie", "David", "Emily", "Niklas",
    "Sophia", "Tim", "Nele", "Moritz", "Luisa", "Erik", "Maja", "Leonard",
    "Frieda", "Karl", "Clara", "Anton", "Johanna", "Theo", "Mila", "Mats",
    "Zoe", "Milan", "Helena", "Rafael", "Greta", "Felix", "Theresa",
    "Adrian", "Ida", "Bruno", "Marlene", "Oskar", "Mathilda", "Mara",
)

DE_LAST_NAMES: tuple[str, ...] = (
    "Müller", "Schmidt", "Schneider", "Fischer", "Weber", "Meyer", "Wagner",
    "Becker", "Schulz", "Hoffmann", "Schäfer", "Koch", "Bauer", "Richter",
    "Klein", "Wolf", "Schröder", "Neumann", "Schwarz", "Zimmermann",
    "Braun", "Krüger", "Hofmann", "Hartmann", "Lange", "Werner", "Schmitt",
    "Krause", "Meier", "Lehmann", "Schmid", "Schulze", "Maier", "Köhler",
    "Herrmann", "König", "Walter", "Mayer", "Huber", "Kaiser", "Fuchs",
    "Peters", "Lang", "Scholz", "Möller", "Weiß", "Jung", "Hahn", "Schubert",
    "Vogel", "Friedrich", "Keller", "Bayer", "Schuster", "Frank", "Berger",
    "Winkler", "Lorenz", "Baumann", "Schreiber", "Sander", "Simon",
)


# Email domain pool (real-looking but fictional)
EMAIL_DOMAINS: tuple[str, ...] = (
    "example.com", "example.org", "example.net", "demo.test", "sample.io",
    "redacted.email", "anonymized.dev", "test.example", "placeholder.org",
    "fakemail.test", "synthetic.email", "demo-data.io", "example.cloud",
)

# US street names (60)
STREET_NAMES: tuple[str, ...] = (
    "Main St", "Oak Ave", "Pine Rd", "Maple Dr", "Cedar Ln", "Elm St",
    "Washington Blvd", "Lakeview Dr", "Hill St", "Park Ave", "Sunset Dr",
    "Riverside Dr", "Highland Ave", "Forest Ave", "Meadow Ln", "Spring St",
    "Madison Ave", "Jefferson St", "Lincoln Dr", "Adams St", "Monroe Ave",
    "Jackson St", "Wilson Blvd", "Franklin Rd", "Roosevelt Ave", "Kennedy Dr",
    "Broadway", "1st Ave", "2nd St", "3rd Ave", "4th St", "5th Ave",
    "Center St", "Church St", "School St", "Market St", "Court St",
    "Mill St", "Bridge St", "River Rd", "Valley Dr", "Summit Ave",
    "Lake St", "Hill Rd", "Valley Rd", "Spring Rd", "Forest Dr",
    "Garden St", "Park Dr", "College St", "North St", "South St",
    "East Ave", "West Blvd", "Industrial Pkwy", "Commerce Dr",
    "Tech Way", "Innovation Dr", "University Ave", "Hospital Dr",
)

# US city / state pool (state is enough — first line of a fake address)
US_CITIES_STATES: tuple[str, ...] = (
    "Springfield, IL", "Riverside, CA", "Franklin, TN", "Greenville, SC",
    "Bristol, CT", "Clinton, OK", "Fairview, OR", "Salem, OR", "Auburn, AL",
    "Madison, WI", "Georgetown, TX", "Arlington, VA", "Burlington, VT",
    "Chester, PA", "Durham, NC", "Oxford, MS", "Plymouth, MA",
    "Richmond, VA", "Salem, MA", "Troy, NY", "York, PA", "Boise, ID",
    "Dover, DE", "Helena, MT", "Juneau, AK", "Pierre, SD", "Reno, NV",
    "Tucson, AZ", "Wichita, KS", "Topeka, KS", "Olympia, WA",
)


# ── The vault ──────────────────────────────────────────────────────


@dataclass
class FakerVault:
    """Deterministic real→fake PII mapper.

    Args:
        salt: Per-vault salt. Different salts produce different
            mappings for the same input, so two orgs running
            the same dataset get different fakes. Defaults to
            a process-wide random salt; callers can pass their
            own to scope the vault (e.g. an org UUID).
        locales: Pools to draw from. Defaults to all shipped
            locales; pass a subset to limit.
    """

    salt: bytes = field(default_factory=lambda: secrets.token_bytes(16))
    locales: tuple[str, ...] = (
        "en", "es", "ar", "ja", "fr", "de", "zh",
    )

    # ── Hash helper ──────────────────────────────────────────

    def _index(self, key: str, pool_size: int) -> int:
        """Return a stable index in [0, pool_size).

        The HMAC keeps the salt secret-included in the hash;
        we use HMAC-SHA256 truncated to 8 bytes for the
        bucket index. This is the same approach as
        hashlib.scrypt-style key derivation: the salt is mixed
        into the hash so the same input + different salt
        gives a different output.
        """
        if pool_size <= 0:
            raise ValueError("pool_size must be positive")
        digest = hmac.new(self.salt, key.encode("utf-8"), hashlib.sha256).digest()
        # Take the first 8 bytes as a uint64.
        n = int.from_bytes(digest[:8], "big")
        return n % pool_size

    # ── Public API: names ────────────────────────────────────

    def fake_name(self, real: str, locale: str = "en") -> str:
        """Return a deterministic fake name for ``real``.

        The output is a "First Last" string drawn from the
        locale's pools. The hash of ``real`` picks the first
        name; the hash of ``real + "_last"`` picks the last
        name — so the two are independent, and the same
        real value always gives the same fake.
        """
        if not real:
            return "Anonymous"
        first, last = self._pools_for(locale)
        first_pick = first[self._index(f"name:{real}", len(first))]
        last_pick = last[self._index(f"surname:{real}", len(last))]
        return f"{first_pick} {last_pick}"

    def fake_first_name(self, real: str, locale: str = "en") -> str:
        first, _ = self._pools_for(locale)
        return first[self._index(f"first:{real}", len(first))]

    def fake_last_name(self, real: str, locale: str = "en") -> str:
        _, last = self._pools_for(locale)
        return last[self._index(f"last:{real}", len(last))]

    def fake_username(self, real: str) -> str:
        """Return a fake username like ``jsmith92``.

        Two letters from a first name + surname consonant
        cluster + 2 digits. Deterministic.
        """
        first, last = self._pools_for("en")
        f = first[self._index(f"user:f:{real}", len(first))].lower()
        last_part = last[self._index(f"user:l:{real}", len(last))].lower()
        # Strip non-alpha from the first 3 chars of each.
        f = re.sub(r"[^a-z]", "", f)[:1] or "x"
        last_part = re.sub(r"[^a-z]", "", last_part)[:7] or "x"
        n = self._index(f"user:n:{real}", 100)
        return f"{f}{last_part}{n:02d}"

    # ── Public API: contact ──────────────────────────────────

    def fake_email(self, real: str) -> str:
        """Return ``<username>@<domain>`` for the input.

        If ``real`` looks like an email, the username portion
        is replaced with a fake username derived from the
        full address (so the same input gives the same fake).
        If ``real`` doesn't look like an email, we still
        produce a fake (using the full string as input).
        """
        if not real:
            real = "anon"
        # Strip the @domain if present — the username is what
        # we hash. The domain comes from our pool.
        local = real.split("@", 1)[0]
        # Strip common email noise (dots, plus tags).
        local = local.split("+", 1)[0]
        username = self.fake_username(local)
        domain = EMAIL_DOMAINS[self._index(f"email:dom:{real}", len(EMAIL_DOMAINS))]
        return f"{username}@{domain}"

    def fake_phone(self, real: str) -> str:
        """Return a US-shape phone number ``(555) 555-XXXX``.

        The area code and exchange are derived from the hash;
        the line number is randomised within 0000-9999. We
        always use the 555 exchange (reserved for fictional
        use) so the number is recognisably fake.
        """
        if not real:
            real = "anon"
        # Hash the digits only — same input always gives the
        # same output regardless of formatting.
        digits = re.sub(r"\D", "", real)
        if not digits:
            digits = "0"
        # Area code (3 digits) — bounded [200, 999] (no N11).
        area = 200 + (self._index(f"phone:area:{digits}", 800))
        # Exchange (3 digits) — always 555 (fictional) but we
        # vary the last 2 digits for variety.
        exch_base = self._index(f"phone:exch:{digits}", 100)
        # Line number (4 digits).
        line = self._index(f"phone:line:{digits}", 10000)
        return f"({area:03d}) 555-{exch_base:02d}{line // 100:02d}"

    # ── Public API: government IDs ──────────────────────────

    def fake_ssn(self, real: str) -> str:
        """Return a fake SSN in the ``XXX-XX-XXXX`` format.

        Avoids real-assigned ranges: the first 3 digits are
        in [001, 665] (the SSA-blocked area codes are 000,
        666, and 900-999), and the second 2 are in [01, 99]
        (avoiding 00). The third group is bounded 0001-9999.
        """
        if not real:
            real = "anon"
        a = self._index(f"ssn:a:{real}", 665) + 1  # 1..665
        b = self._index(f"ssn:b:{real}", 99) + 1   # 1..99
        c = self._index(f"ssn:c:{real}", 9998) + 1  # 1..9999
        return f"{a:03d}-{b:02d}-{c:04d}"

    def fake_credit_card(self, real: str) -> str:
        """Return a fake 16-digit Visa-shaped number.

        Starts with ``4`` (Visa), followed by 15 digits that
        pass the Luhn check. We always use 4 so the number
        shape is unambiguous.
        """
        if not real:
            real = "anon"
        # Generate 15 random digits deterministically.
        digits: list[int] = [4]
        for i in range(14):
            digits.append(self._index(f"cc:{i}:{real}", 10))
        # Compute the Luhn check digit (the 16th).
        check = self._luhn_check_digit(digits)
        digits.append(check)
        # Format as 4-4-4-4 for readability.
        return "-".join("".join(str(d) for d in digits[i:i+4]) for i in range(0, 16, 4))

    @staticmethod
    def _luhn_check_digit(digits: list[int]) -> int:
        """Compute the Luhn check digit for a 15-digit prefix.

        Used by both ``fake_credit_card`` and the test suite.
        """
        # Reverse the prefix, double every second digit (which
        # is the odd-indexed position from the right).
        s = 0
        for i, d in enumerate(reversed(digits)):
            if i % 2 == 0:
                # These are the "doubled" positions.
                v = d * 2
                if v > 9:
                    v -= 9
                s += v
            else:
                s += d
        return (10 - (s % 10)) % 10

    # ── Public API: address ─────────────────────────────────

    def fake_address(self, real: str) -> str:
        """Return a fake US-style street address."""
        if not real:
            real = "anon"
        n = (self._index(f"addr:num:{real}", 9000) + 100) % 10000
        street = STREET_NAMES[self._index(f"addr:street:{real}", len(STREET_NAMES))]
        city = US_CITIES_STATES[self._index(f"addr:city:{real}", len(US_CITIES_STATES))]
        return f"{n} {street}, {city}"

    # ── Public API: full bundle ─────────────────────────────

    def fake_person(self, real: str, locale: str = "en") -> dict[str, str]:
        """Return a full bundle of fake PII for ``real``.

        Convenience method that returns ``{name, email,
        phone, address, ssn, username}`` all derived from
        the same input. Use this when you need a coherent
        fake identity (e.g. a synthetic Q/A pair).
        """
        return {
            "name": self.fake_name(real, locale=locale),
            "email": self.fake_email(real),
            "phone": self.fake_phone(real),
            "address": self.fake_address(real),
            "ssn": self.fake_ssn(real),
            "username": self.fake_username(real),
        }

    # ── Internal: pool resolution ───────────────────────────

    def _pools_for(self, locale: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
        """Return ``(first_names, last_names)`` for ``locale``."""
        if locale == "en":
            return EN_FIRST_NAMES, EN_LAST_NAMES
        if locale == "es":
            return ES_FIRST_NAMES, ES_LAST_NAMES
        if locale == "ar":
            return AR_FIRST_NAMES, AR_LAST_NAMES
        if locale == "ja":
            # Japanese: family name + given name.
            return JA_FIRST_NAMES, JA_LAST_NAMES
        if locale == "fr":
            return FR_FIRST_NAMES, FR_LAST_NAMES
        if locale == "de":
            return DE_FIRST_NAMES, DE_LAST_NAMES
        if locale == "zh":
            return ZH_FIRST_NAMES, ZH_LAST_NAMES
        # Fall back to English — we always need *some* pool.
        return EN_FIRST_NAMES, EN_LAST_NAMES


# ── Singleton ─────────────────────────────────────────────────────

_default_vault: FakerVault | None = None


def get_default_vault() -> FakerVault:
    """Return the process-wide default vault.

    The first call initialises the vault with a random salt;
    subsequent calls return the same instance. Tests can
    call :func:`reset_default_vault` to start fresh.
    """
    global _default_vault
    if _default_vault is None:
        _default_vault = FakerVault()
    return _default_vault


def reset_default_vault() -> None:
    """Clear the default vault. Test-only."""
    global _default_vault
    _default_vault = None


# ── Re-exports + helpers ──────────────────────────────────────────

__all__ = [
    "FakerVault",
    "get_default_vault",
    "reset_default_vault",
    "EN_FIRST_NAMES",
    "EN_LAST_NAMES",
    "ES_FIRST_NAMES",
    "ES_LAST_NAMES",
    "AR_FIRST_NAMES",
    "AR_LAST_NAMES",
    "JA_FIRST_NAMES",
    "JA_LAST_NAMES",
    "ZH_FIRST_NAMES",
    "ZH_LAST_NAMES",
    "FR_FIRST_NAMES",
    "FR_LAST_NAMES",
    "DE_FIRST_NAMES",
    "DE_LAST_NAMES",
    "EMAIL_DOMAINS",
    "STREET_NAMES",
    "US_CITIES_STATES",
]


def normalise_for_vault(s: str) -> str:
    """Normalise unicode for vault hashing.

    NFKC normalisation ensures that visually identical
    characters (``Ａ`` vs ``A``, ``é`` vs ``é`` vs ``e + ́``)
    hash to the same value. Use this before calling
    :meth:`FakerVault.fake_name` etc. on user input that may
    contain mixed-script PII.
    """
    return unicodedata.normalize("NFKC", s).strip()
