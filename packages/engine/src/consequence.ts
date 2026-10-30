/**
 * Consequence probes: the constraint an action runs into is often written in words the request never uses. "Deploy
 * the migration on Thursday" shares no word with "production change freeze 4–9 Nov"; "delete the customer's data"
 * none with "legal hold"; "pay the invoice to the new IBAN" none with "security alert: vendor mailbox compromised".
 * No search for the request finds them, and nothing in the user's cache bridges the vocabularies (the cache holds only
 * what lookups returned).
 *
 * What does bridge them is general knowledge of how organisations and people constrain an action. Change management
 * freezes releases; legal and compliance hold data from deletion; finance controls guard payments against changed
 * bank details; confidentiality governs sharing; budgets and approvals govern spend; documents, strikes and
 * advisories govern travel; allergies and diets govern food; headcount and investigations govern hiring. So a request
 * that acts is classified, by general verb lexicons, into one of a few action classes, and one extra query of that
 * class's constraint vocabulary is sent (`Partner.probe`, `consequenceProbe`). What it finds is delivered with no
 * model only when the structural conflict test (`conflict.ts`) says it conflicts with the request, tied by the class's
 * own words.
 *
 * `CLASSES` is the whole of the domain knowledge, in one table, written from general practice (ITIL change
 * management, records retention and litigation holds, payment-fraud controls, information classification,
 * procurement, travel documents, food-allergen rules, HR) before any benchmark was run, and not adjusted to any
 * benchmark item since. Everything here is linear: one bounded pass of fixed alternations, no nested quantifiers.
 */

/** One action class: what requests of it say, and what constrains it. */
export interface ActionClass {
  readonly id: string;
  /** The request's verbs and nouns of this action, as one alternation of whole words (lower case). */
  readonly acts: RegExp;
  /**
   * The constraint vocabulary: single words, most general first. A source that searches any word gets them all in
   * one query; one that needs every word gets them one at a time, a different one each lookup (`nextTerm`).
   */
  readonly terms: readonly string[];
  /**
   * Words that tie a constraint statement to this class's action ("production" for a release, "payments" for a
   * payment): with the terms themselves, they stand in for the request's own words in the conflict test's tie.
   */
  readonly ties: readonly string[];
  /**
   * Whom the class's constraints bind. "general": everyone in the organisation, or the user themself (a change freeze,
   * a hiring freeze, a budget rule, the user's own passport), so a constraint holds whoever the request names.
   * "party": one party (a hold on one client's records, an alert about one vendor, one guest's allergy, one
   * document's confidentiality), so with no model it is raised only when it names someone the request names.
   */
  readonly scope: "general" | "party";
}

const words = (s: string) =>
  new RegExp(
    `\\b(?:${s
      .trim()
      .split(/\s*\|\s*/)
      .join("|")})\\b`,
  );

/**
 * The classes, most specific first: a request is the first class whose verbs it uses ("pay the hotel" is a payment
 * before it is travel). Scheduling with a named person is not here: the person probes already ask for that person,
 * and their absences are grounded by `groundAway`.
 */
export const CLASSES: readonly ActionClass[] = [
  {
    // Records management: a litigation or legal hold suspends deletion; retention schedules and audits forbid it.
    id: "delete",
    acts: words(
      "delete|deleting|deletion|erase|erasing|erasure|purge|purging|wipe|wiping|destroy|destroying|shred|shredding|" +
        "expunge|scrub|anonymi[sz]e|deprovision|decommission|offboard their data|remove (?:their|the|all|his|her) " +
        "(?:data|records|files|account|emails|history)|close (?:their|the|his|her) account",
    ),
    terms: ["litigation", "preservation", "retention", "subpoena", "hold", "audit", "lawsuit", "discovery"],
    scope: "party",
    ties: [
      "data",
      "record",
      "records",
      "account",
      "accounts",
      "files",
      "file",
      "emails",
      "documents",
      "customer",
      "customers",
      "client",
      "information",
      "delete",
      "deletion",
      "deleted",
      "deleting",
      "erase",
      "erasure",
      "purge",
      "destroy",
      "destruction",
      "legal",
    ],
  },
  {
    // Payment controls: changed bank details and compromised mailboxes are the classic fraud; holds stop payment.
    id: "pay",
    acts: words(
      "pay|paying|payment|repay|transfer|wire|remit|remittance|refund|reimburse|settle the (?:invoice|bill|balance)|" +
        "send (?:the )?(?:money|funds|payment)|payout|pay out|release (?:the )?payment",
    ),
    terms: ["fraud", "phishing", "compromised", "scam", "impersonation", "suspicious", "iban", "verification"],
    scope: "party",
    ties: [
      "pay",
      "paid",
      "payment",
      "payments",
      "invoice",
      "invoices",
      "bank",
      "banking",
      "details",
      "iban",
      "account",
      "transfer",
      "transfers",
      "wire",
      "vendor",
      "vendors",
      "supplier",
      "suppliers",
      "funds",
      "money",
      "remittance",
      "refund",
      "refunds",
      "finance",
    ],
  },
  {
    // Change management: freezes, moratoria and blackout windows around releases; open incidents and maintenance.
    id: "release",
    acts: words(
      "deploy|deploying|deployment|release|releasing|ship|shipping|roll out|rolling out|rollout|launch|launching|" +
        "migrate|migrating|migration|upgrade|upgrading|patch|patching|hotfix|go live|go-live|cut over|cutover|" +
        "push (?:it |this |the [a-z]+ )?to (?:prod|production|live)|merge|restart|reboot|failover|rotate the keys",
    ),
    terms: ["freeze", "moratorium", "blackout", "embargo", "incident", "outage", "maintenance", "rollback"],
    scope: "general",
    ties: [
      "production",
      "prod",
      "deploy",
      "deploys",
      "deployment",
      "deployments",
      "release",
      "releases",
      "change",
      "changes",
      "rollout",
      "rollouts",
      "migration",
      "migrations",
      "launch",
      "launches",
      "live",
      "system",
      "systems",
      "code",
      "infrastructure",
      "database",
      "merge",
      "merges",
    ],
  },
  {
    // Employment: hiring freezes and headcount, investigations and grievances, probation and tribunal rules.
    id: "people",
    acts: words(
      "hire|hiring|recruit|recruiting|onboard|onboarding|(?:make|extend|send) (?:an|the|a) offer|offer letter|" +
        "promote|promotion|terminate|termination|fire|dismiss|dismissal|lay off|layoff|let (?:him|her|them) go|" +
        "headcount|contractor|backfill|pay rise|salary increase",
    ),
    terms: ["headcount", "freeze", "investigation", "grievance", "probation", "tribunal", "disciplinary", "embargo"],
    scope: "general",
    ties: [
      "hire",
      "hires",
      "hiring",
      "headcount",
      "offer",
      "offers",
      "role",
      "roles",
      "candidate",
      "candidates",
      "recruit",
      "recruiting",
      "recruitment",
      "salary",
      "salaries",
      "employee",
      "employees",
      "staff",
      "contractor",
      "contractors",
      "termination",
      "dismissal",
    ],
  },
  {
    // Travel: documents (passport, visa) and their expiry, strikes, advisories and disruption, travel policy.
    id: "travel",
    acts: words(
      "fly|flying|flight|flights|travel|travelling|traveling|trip|book (?:a |the |my )?(?:train|hotel|flight|" +
        "taxi|car|ferry)|airport|abroad|overseas|itinerary",
    ),
    terms: ["passport", "visa", "strike", "advisory", "disruption", "restriction", "expired", "expires"],
    scope: "general",
    ties: [
      "travel",
      "trip",
      "trips",
      "flight",
      "flights",
      "fly",
      "flying",
      "hotel",
      "train",
      "trains",
      "airport",
      "airline",
      "border",
      "journey",
      "abroad",
      "passport",
      "visa",
      "country",
      "rail",
    ],
  },
  {
    // Food and gatherings: allergens and diets (food-safety practice asks for them first), access needs. Providing
    // food or a venue for people, not meeting over a meal: "lunch with Sam on Friday" is scheduling, and Sam's
    // absences are the person probes' to find.
    id: "food",
    acts: words(
      "(?:book|reserve|order|organi[sz]e|plan|host|arrange|throw|get|buy|make|bring) (?:[a-z'-]+ ){0,4}(?:dinner|" +
        "lunch|breakfast|brunch|meal|meals|restaurant|table|food|pizza|cake|snacks|buffet|picnic|party|" +
        "celebration|barbecue|bbq|takeaway|venue)|cater|catering|caterer|menu|bake|baking|cook|cooking|" +
        "team (?:event|outing|social|dinner|lunch)",
    ),
    terms: ["allergy", "allergic", "dietary", "vegan", "vegetarian", "gluten", "coeliac", "halal"],
    scope: "party",
    ties: [
      "food",
      "eat",
      "eats",
      "eating",
      "dinner",
      "lunch",
      "meal",
      "meals",
      "menu",
      "restaurant",
      "catering",
      "dish",
      "dishes",
      "cook",
      "cooking",
      "serve",
      "served",
      "drinks",
      "cake",
      "snacks",
      "diet",
      "dietary",
      "nuts",
      "dairy",
      "allergy",
      "allergies",
      "allergic",
    ],
  },
  {
    // Spend: budget and spend freezes, purchase approval thresholds, procurement rules.
    id: "spend",
    acts: words(
      "buy|buying|purchase|purchasing|order|ordering|procure|subscribe|subscription|renew|renewal|sign (?:the|a|our)" +
        " (?:contract|agreement|lease|deal|sow|order form)|commit to|lease|invest|spend",
    ),
    terms: ["budget", "freeze", "approval", "procurement", "overspend", "limit", "moratorium", "cap"],
    scope: "general",
    ties: [
      "spend",
      "spending",
      "purchase",
      "purchases",
      "purchasing",
      "buy",
      "buying",
      "order",
      "orders",
      "budget",
      "budgets",
      "contract",
      "contracts",
      "vendor",
      "vendors",
      "subscription",
      "subscriptions",
      "renewal",
      "renewals",
      "procurement",
      "expense",
      "expenses",
      "cost",
      "costs",
      "software",
      "licences",
      "licenses",
    ],
  },
  {
    // Information sharing: classification (confidential, internal only), NDAs, embargoes before announcements.
    id: "share",
    acts: words(
      "share|sharing|forward|publish|publishing|post (?:it|this|the)|disclose|circulate|distribute|announce|" +
        "upload|send (?:\\w+ )?(?:the|our|my|a|this|them|him|her) (?:\\w+ )?(?:report|deck|file|files|document|" +
        "doc|docs|spreadsheet|data|figures|numbers|results|contract|draft|slides|list|pdf|attachment|roadmap|plan|" +
        "proposal|financials|pricing|minutes|presentation|forecast|model|memo|analysis|details)",
    ),
    terms: ["confidential", "embargo", "nda", "privileged", "restricted", "internal", "sensitive", "leak"],
    scope: "party",
    ties: [
      "share",
      "sharing",
      "shared",
      "send",
      "forward",
      "forwarded",
      "external",
      "externally",
      "outside",
      "distribute",
      "distribution",
      "circulate",
      "publish",
      "disclose",
      "disclosure",
      "report",
      "reports",
      "document",
      "documents",
      "deck",
      "figures",
      "results",
      "data",
      "numbers",
      "announcement",
    ],
  },
];

/** A request's head: the action is named early, and the bound keeps the pass linear in a fixed length. */
const HEAD = 400;

/**
 * The class of a request that acts, or null: the first class (`CLASSES` order) whose verbs the request's head uses.
 * `acting` says the caller knows the request acts (it starts with an imperative or a polite ask, `isAction`, or it
 * arrived from outside); otherwise only a request that starts with the class's own verb acts ("Deploy the
 * migration", "Wire the deposit"): a question about a release ("did the release go out?") is not a release.
 */
export function actionClass(raw: string, acting = true): ActionClass | null {
  const t = raw.slice(0, HEAD).trim().toLowerCase().replace(/\s+/g, " ");
  for (const c of CLASSES) {
    const m = c.acts.exec(t);
    if (m && (acting || m.index === 0)) return c;
  }
  return null;
}

/** Whether a lower-case text holds a word whole (not inside another: "hold" is not in "holder"). */
export function hasWord(hay: string, word: string): boolean {
  if (!word) return false;
  let at = hay.indexOf(word);
  while (at >= 0) {
    const before = at === 0 ? " " : hay[at - 1]!;
    const after = hay[at + word.length] ?? " ";
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    at = hay.indexOf(word, at + 1);
  }
  return false;
}
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Whether an item's text holds one of a class's constraint terms, whole words: its find matched the class. */
export function matchesClass(c: ActionClass, text: string): boolean {
  const hay = text.slice(0, 4_000).toLowerCase();
  return c.terms.some((t) => hasWord(hay, t));
}

/** The words that tie a constraint to the class's action in the conflict test: its ties and its terms. */
export function classTies(c: ActionClass): Set<string> {
  return new Set([...c.ties, ...c.terms]);
}
