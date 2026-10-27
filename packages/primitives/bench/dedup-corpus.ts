/**
 * A synthetic but realistic mailbox for dedup benchmarks: email threads in five languages with replies quoted the
 * way Gmail, Outlook, Apple Mail and Thunderbird quote them, interleaved and bottom-posted replies, acknowledgements,
 * forwards with and without a note, signatures and mobile footers, synced copies (CRLF, rewrapped, NFD accents,
 * smart quotes, a mailing-list footer, a CRM log header), documents with minor and major edits, and templated
 * notifications that differ only in their facts.
 *
 * Every item carries a `group`: items in one group carry the same information (a synced copy, a bare forward, an
 * acknowledgement and the message it quotes, a minor edit); items in different groups do not. Email items also carry
 * per-line labels, so a quote stripper can be scored line by line.
 *
 * Seeds: parameters are chosen on seed 1 ("dev") and reported on seed 2 ("test"), so nothing is tuned to the numbers
 * reported. Text is assembled from ~180 hand-written sentences with slots, plus a phrase grammar for English.
 */

export const L_OWN = 0;
export const L_QUOTE = 1;
export const L_HEADER = 2;
export const L_FORWARD = 3;
export const L_SIGNATURE = 4;
export const L_GREETING = 5;
export const L_CLOSING = 6;
export const L_BLANK = 7;

export interface Item {
  id: number;
  text: string;
  /** Items with the same group carry the same information. */
  group: number;
  /** How the item was made: msg, reply, ack, fwd-bare, fwd-fyi, fwd-note, sync-*, doc, doc-minor, doc-major, notif. */
  kind: string;
  /** For labelled items, `text` is `lines.join("\n")` and `labels[i]` is line i's L_* label. */
  lines: string[] | null;
  labels: number[] | null;
  /** Client style of the quote or forward, for per-style scores. */
  style: string;
}

type Lang = "en" | "fr" | "de" | "es" | "ja";

class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    // mulberry32
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(a: readonly T[]): T {
    return a[this.int(a.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

const PEOPLE = [
  "Dana Lee",
  "Priya Raman",
  "Marc Dubois",
  "Jan Müller",
  "Ana García",
  "Kenji Tanaka",
  "Sofia Rossi",
  "Lukas Novak",
  "Chloé Martin",
  "Tomás Herrera",
  "Yuki Sato",
  "Fatima Zahra",
  "Oliver Bennett",
  "Mei Chen",
  "Arjun Mehta",
  "Sam O'Neill",
  "Ingrid Larsen",
  "Pedro Alves",
  "Hana Kim",
  "Elif Yılmaz",
  "Grace Okafor",
  "Mateo Rojas",
  "Léa Bernard",
  "Felix Schneider",
  "Isabel Costa",
  "Noah Fischer",
  "Aiko Watanabe",
  "Ravi Shah",
  "Emma Johansson",
  "Lucas Moreau",
];
const COMPANIES = [
  "Globex",
  "Initech",
  "Acme",
  "Umbrella Health",
  "Northwind",
  "Contoso",
  "Hooli",
  "Stark Logistics",
  "Vandelay Imports",
  "Tyrell Bio",
  "Aperture Labs",
  "Massive Dynamic",
  "Wonka Foods",
  "Soylent",
  "Oscorp",
];
const PROJECTS = [
  "Phoenix",
  "the Q4 renewal",
  "the Lisbon offsite",
  "the billing migration",
  "the SOC 2 audit",
  "the mobile v3 launch",
  "the hiring plan",
  "the pricing page redesign",
  "the data retention policy",
  "the partner program",
  "the warehouse move",
  "the onboarding revamp",
];
const CITIES = ["Lisbon", "Berlin", "Austin", "Lyon", "Osaka", "Madrid", "Toronto", "Milan", "Denver", "Porto"];
const DAYS_EN = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Ctx {
  rng: Rng;
  lang: Lang;
}

function fill(c: Ctx, template: string): string {
  const r = c.rng;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    switch (k) {
      case "P":
      case "P2":
        return r.pick(PEOPLE).split(" ")[0]!;
      case "C":
        return r.pick(COMPANIES);
      case "X":
        return r.pick(PROJECTS);
      case "CITY":
        return r.pick(CITIES);
      case "D":
        return pickDay(c);
      case "T":
        return `${8 + r.int(10)}:${r.pick(["00", "15", "30", "45"])}`;
      case "N":
        return String(2 + r.int(60));
      case "N2":
        return String(2 + r.int(30));
      case "M":
        return c.lang === "en" ? `$${(1 + r.int(90)) * 100}` : `${(1 + r.int(90)) * 100} €`;
      case "DATE":
        return c.lang === "en" ? `${r.pick(MONTHS_EN)} ${1 + r.int(28)}` : `${1 + r.int(28)}.${1 + r.int(12)}.`;
      case "ID":
        return String(10000 + r.int(89999));
      default:
        return k;
    }
  });
}

function pickDay(c: Ctx): string {
  const days: Record<Lang, string[]> = {
    en: DAYS_EN,
    fr: ["lundi", "mardi", "mercredi", "jeudi", "vendredi"],
    de: ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag"],
    es: ["lunes", "martes", "miércoles", "jueves", "viernes"],
    ja: ["月曜日", "火曜日", "水曜日", "木曜日", "金曜日"],
  };
  return c.rng.pick(days[c.lang]);
}

const EN = [
  "Can we move the {X} sync to {D} at {T}?",
  "I talked to {P} at {C} and they are open to a {N}-month extension.",
  "The invoice for {M} is attached; payment terms are net {N}.",
  "Quick reminder that the deadline for {X} is {DATE}.",
  "Legal flagged two clauses in the {C} contract: the auto-renewal and the liability cap.",
  "Our flight lands at {T} on {D}, so I will join the dinner late.",
  "{P} will own the follow-up with {C} until {P2} is back from leave.",
  "I pushed the draft to the shared folder; comments are welcome before {D}.",
  "Revenue for last quarter came in {N}% above plan, mostly from enterprise renewals.",
  "Could you send me the signed NDA so I can forward it to procurement?",
  "We decided to pause {X} until the budget review on {DATE}.",
  "Support saw {N} tickets about the login bug since {D}.",
  "Please confirm the headcount for {X} by end of day.",
  "I booked three nights at a small hotel near the old town in {CITY}.",
  "The demo went well and {P} asked for a pricing proposal by {D}.",
  "Let me know if {T} works, otherwise I can do any time after lunch.",
  "The new onboarding flow cut drop-off from {N}% to {N2}%.",
  "I am out of office from {DATE} and {P} is covering for me.",
  "Attached are the meeting notes and the list of action items.",
  "We need a decision on the vendor shortlist before the board meeting.",
  "{C} asked whether we can support single sign-on with their identity provider.",
  "The staging deploy failed twice because of a missing environment variable.",
  "Can you review the hiring plan and flag anything that looks off?",
  "I moved our one-on-one to {D} because of the all-hands.",
  "The landlord confirmed the lease renewal at {M} per month.",
  "Dinner on {D} is at {T}; I reserved a table for {N}.",
  "My daughter has a school play on {D} afternoon, so I will be offline after {T}.",
  "Most answers in the security questionnaire from {C} can come straight from our audit report.",
  "Shipping is delayed by {N2} days because of the port strike.",
  "Sorry for the slow reply, last week was a blur.",
  "Happy to jump on a call if that is easier.",
  "The quote from {C} came in at {M}, which is {N}% higher than last year.",
  "We should loop in {P} before we commit to the timeline.",
  "I updated the roadmap doc with the changes we discussed on {D}.",
  "The analytics dashboard shows a dip in weekly actives since the release.",
  "Could you share the slides from the review of {X}?",
  "{P} accepted the offer and starts on {DATE}.",
  "The renewal call with {C} is confirmed for {D} at {T}.",
  "Expense reports are due by {DATE}, receipts included.",
  "Please do not share the draft outside the team yet.",
  "I think we can close the ticket once the fix is verified in production.",
  "The contractor estimates {N} hours for the kitchen work, materials not included.",
  "The pediatrician moved the appointment to {D} at {T}.",
  "Our insurance renewal went up by {N2}%, so I asked {P} for two more quotes.",
  "I left the spare key with the neighbours in case the plumber arrives early.",
  "The conference in {CITY} accepted our talk, so we need slides by {DATE}.",
  "{C} wants a discount of {N2}% in exchange for a three-year commitment.",
  "Engineering thinks the migration can finish in {N2} weeks if nothing else slips.",
  "I could not find the purchase order number anywhere in the thread.",
  "The candidate from {C} was strong on systems design but weak on communication.",
  "Finance needs the cost center code before they can approve the trip.",
  "There is a fire drill on {D} morning, so the office will be empty for an hour.",
  "The second draft reads much better, especially the section on risks.",
  "We lost the {C} deal to a cheaper competitor, mostly on price.",
  "I will be in {CITY} on {D} and {D} if you want to grab coffee.",
  "The board deck still needs the churn numbers and the hiring update.",
  "The printer on the third floor is broken again, facilities is on it.",
  "Can you double-check the tax figures before we file on {DATE}?",
  "{P} suggested we run a two-week pilot with {C} before signing.",
  "The API rate limits from {C} are much lower than they advertised.",
];
const EN_SUBJECTS = [
  "We",
  "I",
  "{P}",
  "The team",
  "{C}",
  "Finance",
  "Our designer",
  "The client",
  "Legal",
  "Marketing",
];
const EN_VERBS = [
  "need to finalize",
  "are still reviewing",
  "will send over",
  "already approved",
  "want to revisit",
  "cannot sign off on",
  "should prioritize",
  "have to reschedule",
  "asked about",
  "are waiting on",
];
const EN_OBJECTS = [
  "the budget for {X}",
  "the updated contract",
  "the launch checklist",
  "the travel plans for {CITY}",
  "the onboarding docs",
  "the pricing tiers",
  "the quarterly report",
  "the security review",
  "the migration plan",
  "the customer escalation from {C}",
  "the offer letter for {P}",
  "the invoice from {C}",
];
const EN_TAILS = [
  " before {D}",
  " by end of week",
  " after the review of {X}",
  " this afternoon",
  " once {P} is back",
  " next quarter",
  " by {DATE}",
  "",
  "",
];
const FR = [
  "Peut-on décaler le point sur {X} à {D} à {T} ?",
  "J'ai parlé avec {P} chez {C}, ils sont ouverts à une prolongation de {N} mois.",
  "La facture de {M} est en pièce jointe, paiement à {N} jours.",
  "Petit rappel : la date limite pour {X} est le {DATE}.",
  "Le service juridique a relevé deux clauses dans le contrat {C}.",
  "Notre vol atterrit à {T} {D}, je rejoindrai le dîner en retard.",
  "{P} s'occupe du suivi avec {C} jusqu'au retour de {P2}.",
  "J'ai mis le brouillon dans le dossier partagé, vos remarques sont les bienvenues avant {D}.",
  "Le chiffre d'affaires du trimestre dépasse le plan de {N} %.",
  "Pourrais-tu m'envoyer l'accord de confidentialité signé ?",
  "Nous avons décidé de suspendre {X} jusqu'à la revue budgétaire.",
  "Le support a reçu {N} tickets sur le bug de connexion depuis {D}.",
  "Merci de confirmer le nombre de participants pour {X} avant ce soir.",
  "J'ai réservé trois nuits dans un petit hôtel à {CITY}.",
  "La démo s'est bien passée et {P} demande une proposition tarifaire.",
  "Dis-moi si {T} te convient, sinon je suis libre après le déjeuner.",
  "Je serai absent à partir du {DATE}, {P} me remplace.",
  "Il faut trancher sur la liste des fournisseurs avant le conseil.",
  "Le déploiement en préproduction a échoué deux fois à cause d'une variable manquante.",
  "Le devis de {C} est de {M}, soit {N} % de plus que l'an dernier.",
  "Le dentiste a déplacé le rendez-vous à {D} à {T}.",
  "Le loyer passe à {M} par mois à partir du {DATE}.",
];
const DE = [
  "Können wir den Termin zu {X} auf {D} um {T} verschieben?",
  "Ich habe mit {P} von {C} gesprochen, sie sind offen für eine Verlängerung um {N} Monate.",
  "Die Rechnung über {M} ist angehängt, Zahlungsziel {N} Tage.",
  "Kurze Erinnerung: Die Frist für {X} ist der {DATE}.",
  "Die Rechtsabteilung hat zwei Klauseln im Vertrag mit {C} markiert.",
  "Unser Flug landet am {D} um {T}, ich komme also später zum Abendessen.",
  "{P} übernimmt die Nachverfolgung mit {C}, bis {P2} aus dem Urlaub zurück ist.",
  "Der Entwurf liegt im gemeinsamen Ordner, Kommentare bitte bis {D}.",
  "Der Umsatz lag im letzten Quartal {N} % über Plan.",
  "Kannst du mir die unterschriebene Vertraulichkeitsvereinbarung schicken?",
  "Wir haben {X} bis zur Budgetrunde am {DATE} pausiert.",
  "Der Support hat seit {D} {N} Tickets zum Login-Fehler bekommen.",
  "Bitte bestätige bis heute Abend die Teilnehmerzahl für {X}.",
  "Ich habe drei Nächte in einem kleinen Hotel in {CITY} gebucht.",
  "Die Demo lief gut und {P} möchte bis {D} ein Preisangebot.",
  "Sag mir, ob {T} passt, sonst geht es nach der Mittagspause.",
  "Ich bin ab dem {DATE} nicht im Büro, {P} vertritt mich.",
  "Wir brauchen vor der Aufsichtsratssitzung eine Entscheidung zur Lieferantenliste.",
  "Das Angebot von {C} liegt bei {M}, {N} % mehr als im Vorjahr.",
  "Der Handwerker kommt am {D} zwischen {T} und Mittag.",
  "Die Kita ist am {D} wegen einer Fortbildung geschlossen.",
  "Die Migration dauert laut Entwicklung etwa {N2} Wochen.",
];
const ES = [
  "¿Podemos mover la reunión de {X} al {D} a las {T}?",
  "Hablé con {P} de {C} y están abiertos a una extensión de {N} meses.",
  "Adjunto la factura de {M}, con pago a {N} días.",
  "Recordatorio: el plazo para {X} vence el {DATE}.",
  "El equipo legal marcó dos cláusulas en el contrato con {C}.",
  "Nuestro vuelo aterriza a las {T} del {D}, así que llegaré tarde a la cena.",
  "{P} se encarga del seguimiento con {C} hasta que vuelva {P2}.",
  "Subí el borrador a la carpeta compartida, se aceptan comentarios antes del {D}.",
  "Los ingresos del trimestre superaron el plan en un {N} %.",
  "¿Me puedes enviar el acuerdo de confidencialidad firmado?",
  "Decidimos pausar {X} hasta la revisión del presupuesto.",
  "Soporte recibió {N} tickets sobre el error de inicio de sesión desde el {D}.",
  "Por favor confirma el número de asistentes para {X} hoy.",
  "Reservé tres noches en un hotel pequeño en {CITY}.",
  "La demo salió bien y {P} pidió una propuesta de precios para el {D}.",
  "Avísame si las {T} te vienen bien, si no puedo después de comer.",
  "Estaré fuera de la oficina desde el {DATE}; {P} me cubre.",
  "El presupuesto de {C} es de {M}, un {N} % más que el año pasado.",
  "El pediatra cambió la cita al {D} a las {T}.",
  "La mudanza del almacén se retrasa {N2} días por la huelga.",
];
const JA = [
  "{X}の定例を{D}の{T}に変更できますか？",
  "{C}の{P}さんと話したところ、{N}か月の延長に前向きでした。",
  "{M}の請求書を添付します。支払い期限は{N}日後です。",
  "{X}の締め切りは{DATE}ですのでご注意ください。",
  "法務から{C}との契約に二つの条項について指摘がありました。",
  "{D}の{T}に到着するので、夕食には遅れて参加します。",
  "{P}さんが{C}とのフォローアップを担当します。",
  "共有フォルダにドラフトを置きました。{D}までにコメントをお願いします。",
  "前四半期の売上は計画を{N}%上回りました。",
  "署名済みの秘密保持契約を送っていただけますか？",
  "予算の見直しまで{X}を一時停止することにしました。",
  "{D}以降、ログインの不具合について{N}件の問い合わせがありました。",
  "{CITY}の小さなホテルを三泊予約しました。",
  "デモは好評で、{P}さんから価格の提案を求められました。",
];
const BANK: Record<Lang, string[]> = { en: EN, fr: FR, de: DE, es: ES, ja: JA };

const GREETINGS: Record<Lang, string[]> = {
  en: ["Hi {P},", "Hello {P},", "Hey {P},", "Dear {P},", "Hi all,", "Hi team,", "Good morning {P},"],
  fr: ["Bonjour {P},", "Salut {P},", "Bonjour à tous,"],
  de: ["Hallo {P},", "Hi {P},", "Liebe {P},", "Guten Morgen {P},"],
  es: ["Hola {P},", "Buenos días {P},", "Hola a todos,"],
  ja: ["{P}さん", "お疲れ様です。"],
};
const CLOSINGS: Record<Lang, string[]> = {
  en: ["Thanks,", "Best,", "Cheers,", "Best regards,", "Thank you!", "Kind regards,", "Talk soon,"],
  fr: ["Merci,", "Cordialement,", "Bonne journée,", "Bien à vous,"],
  de: ["Viele Grüße", "Danke,", "Beste Grüße", "Mit freundlichen Grüßen"],
  es: ["Gracias,", "Saludos,", "Un saludo,", "Atentamente,"],
  ja: ["よろしくお願いします。", "よろしくお願いいたします。"],
};
const ACKS: Record<Lang, string[]> = {
  en: ["Thanks!", "Sounds good.", "Will do.", "Great, thank you.", "Perfect, thanks!", "+1", "Got it, thanks."],
  fr: ["Merci !", "Parfait, merci.", "Ça marche.", "Bien reçu, merci."],
  de: ["Danke!", "Passt, danke.", "Alles klar.", "Super, vielen Dank."],
  es: ["¡Gracias!", "Perfecto, gracias.", "De acuerdo.", "Recibido, gracias."],
  ja: ["承知しました。", "ありがとうございます。", "了解です。"],
};
const FYI: Record<Lang, string[]> = {
  en: ["FYI", "See below.", "Forwarding for visibility.", "FYI, see the thread below.", "fyi"],
  fr: ["Pour info.", "Voir ci-dessous."],
  de: ["Zur Info.", "Siehe unten."],
  es: ["Para tu información.", "Ver abajo."],
  ja: ["ご参考まで。", "転送します。"],
};
const FOOTERS: Record<Lang, string[]> = {
  en: ["Sent from my iPhone", "Sent from my iPad", "Get Outlook for iOS", "Sent from Mail for Windows"],
  fr: ["Envoyé de mon iPhone", "Envoyé depuis Outlook pour Android"],
  de: ["Von meinem iPhone gesendet", "Gesendet von Mail für Windows"],
  es: ["Enviado desde mi iPhone", "Enviado desde Outlook para Android"],
  ja: ["iPhoneから送信"],
};
const TITLES = ["Head of Operations", "Account Executive", "Engineering Manager", "CFO", "Product Lead", "Founder"];

interface Person {
  name: string;
  first: string;
  email: string;
  company: string;
  phone: string;
  /** Signature habit: 0 closing only, 1 closing + "-- " block, 2 nothing, 3 mobile footer. */
  habit: number;
  title: string;
}

function makePerson(r: Rng, name: string): Person {
  const first = name.split(" ")[0]!;
  const company = r.pick(COMPANIES);
  const domain = company.toLowerCase().replace(/[^a-z]/g, "") + ".com";
  const ascii = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, "");
  return {
    name,
    first,
    email: ascii.replace(" ", ".") + "@" + domain,
    company,
    phone: `+1 ${200 + r.int(700)} 555 0${100 + r.int(899)}`,
    habit: r.int(4),
    title: r.pick(TITLES),
  };
}

function sentence(c: Ctx): string {
  const r = c.rng;
  if (c.lang === "en" && r.chance(0.35)) {
    const s = `${r.pick(EN_SUBJECTS)} ${r.pick(EN_VERBS)} ${r.pick(EN_OBJECTS)}${r.pick(EN_TAILS)}.`;
    return fill(c, s);
  }
  return fill(c, r.pick(BANK[c.lang]));
}

function specificSentence(c: Ctx): string {
  return fill(c, c.rng.pick(BANK[c.lang].filter((t) => t.includes("{"))));
}

/** Paragraphs of sentences; short messages are the most common, as in real mail. */
function body(c: Ctx, minSentences: number): string[][] {
  const r = c.rng;
  const u = r.next();
  let total = u < 0.3 ? 1 + r.int(2) : u < 0.7 ? 3 + r.int(3) : u < 0.9 ? 6 + r.int(5) : 11 + r.int(10);
  total = Math.max(total, minSentences);
  const paras: string[][] = [];
  let first = true;
  while (total > 0) {
    const k = Math.min(total, 1 + r.int(4));
    const p: string[] = [];
    for (let i = 0; i < k; i++) {
      // Real mail mentions specifics (a name, a day, an amount). Without this, one-sentence messages drawn from a
      // finite bank repeat word for word across unrelated threads far more often than real mail does.
      p.push(first ? specificSentence(c) : sentence(c));
      first = false;
    }
    paras.push(p);
    total -= k;
  }
  return paras;
}

/** Renders paragraphs as lines, wrapped at `width` (0: one line per paragraph), blank lines between. */
function renderParas(paras: string[][], width: number, joiner: string): string[] {
  const out: string[] = [];
  paras.forEach((p, i) => {
    if (i > 0) out.push("");
    const text = p.join(joiner);
    if (width === 0) out.push(text);
    else out.push(...wrap(text, width));
  });
  return out;
}

function wrap(text: string, width: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length > 0 && line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else line = line.length > 0 ? line + " " + w : w;
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

interface Labelled {
  lines: string[];
  labels: number[];
}

function push(m: Labelled, line: string, label: number): void {
  m.lines.push(line);
  m.labels.push(line.trim() === "" ? L_BLANK : label);
}

/** A message's own part: greeting, body, closing, signature or footer. */
interface Own {
  greeting: string | null;
  paras: string[][];
  ack: string | null;
  sender: Person;
}

function renderOwn(c: Ctx, own: Own, width: number, m: Labelled, signOff: boolean): void {
  const joiner = c.lang === "ja" ? "" : " ";
  if (own.greeting !== null) {
    push(m, own.greeting, L_GREETING);
    push(m, "", L_BLANK);
  }
  // An acknowledgement is scored as don't-care for stripping: keeping or dropping it are both defensible.
  if (own.ack !== null) push(m, own.ack, L_CLOSING);
  for (const l of renderParas(own.paras, width, joiner)) push(m, l, L_OWN);
  if (!signOff) return;
  const s = own.sender;
  const r = c.rng;
  if (s.habit === 2) return;
  if (s.habit === 3) {
    push(m, "", L_BLANK);
    push(m, r.pick(FOOTERS[c.lang]), L_SIGNATURE);
    return;
  }
  push(m, "", L_BLANK);
  push(m, r.pick(CLOSINGS[c.lang]), L_CLOSING);
  push(m, s.first, L_CLOSING);
  if (s.habit === 1) {
    push(m, "", L_BLANK);
    push(m, "-- ", L_SIGNATURE);
    push(m, s.name, L_SIGNATURE);
    push(m, `${s.title} | ${s.company}`, L_SIGNATURE);
    push(m, s.phone, L_SIGNATURE);
  }
}

interface Msg {
  item: Item;
  sender: Person;
  subject: string;
  when: Date;
  lang: Lang;
  own: Own;
}

function fmtDate(lang: Lang, d: Date, style: string): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hh = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const day = d.getUTCDate();
  if (style === "outlook") {
    const long = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const months = ["January", "February", "March", "April", "May", "June", "July", "August"];
    const month = months[mo % 8]!;
    return `${long[d.getUTCDay()]}, ${month} ${day}, ${y} ${((hh + 11) % 12) + 1}:${mm} ${hh < 12 ? "AM" : "PM"}`;
  }
  if (lang === "en") {
    return `${days[d.getUTCDay()]}, ${MONTHS_EN[mo]} ${day}, ${y} at ${((hh + 11) % 12) + 1}:${mm} ${hh < 12 ? "AM" : "PM"}`;
  }
  return `${day}.${mo + 1}.${y} ${hh}:${mm}`;
}

/** The attribution line(s) a client writes above a quote. */
function attribution(lang: Lang, style: string, p: Msg, r: Rng): string[] {
  const s = p.sender;
  const d = p.when;
  const hh = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const day = d.getUTCDate();
  const mo = d.getUTCMonth();
  const y = d.getUTCFullYear();
  let line: string;
  if (style === "apple") {
    line = `On ${MONTHS_EN[mo]} ${day}, ${y}, at ${hh}:${mm}, ${s.name} <${s.email}> wrote:`;
  } else if (style === "thunderbird") {
    line = `On ${mo + 1}/${day}/${String(y).slice(2)} ${hh}:${mm}, ${s.name} wrote:`;
  } else if (lang === "fr") {
    line = `Le mar. ${day} oct. ${y} à ${hh}:${mm}, ${s.name} <${s.email}> a écrit :`;
  } else if (lang === "de") {
    line = `Am Di., ${day}. Okt. ${y} um ${hh}:${mm} Uhr schrieb ${s.name} <${s.email}>:`;
  } else if (lang === "es") {
    line = `El mar, ${day} oct ${y} a las ${hh}:${mm}, ${s.name} (<${s.email}>) escribió:`;
  } else if (lang === "ja") {
    line = `${y}年${mo + 1}月${day}日(火) ${hh}:${mm} ${s.name} <${s.email}>:`;
  } else {
    line = `On ${fmtDate("en", d, "gmail")} ${s.name} <${s.email}> wrote:`;
  }
  // Gmail and others hard-wrap long attribution lines at ~78 columns.
  if (line.length > 78 && r.chance(0.5)) {
    const cut = line.lastIndexOf(" ", 76);
    return [line.slice(0, cut), line.slice(cut + 1)];
  }
  return [line];
}

function quoteLines(text: string, nested: string): string[] {
  return text.split("\n").map((l) => (l.length === 0 ? ">" : l.startsWith(">") ? nested + l : "> " + l));
}

function headerFields(lang: Lang, p: Msg, to: Person, style: string, prefix: string): string[] {
  const s = p.sender;
  if (lang === "fr") {
    return [`De : ${s.name} <${s.email}>`, `Envoyé : ${fmtDate(lang, p.when, style)}`, `À : ${to.name} <${to.email}>`];
  }
  if (lang === "de") {
    return [`Von: ${s.name} <${s.email}>`, `Gesendet: ${fmtDate(lang, p.when, style)}`, `An: ${to.name} <${to.email}>`];
  }
  if (lang === "es") {
    return [`De: ${s.name} <${s.email}>`, `Enviado: ${fmtDate(lang, p.when, style)}`, `Para: ${to.name} <${to.email}>`];
  }
  return [
    `From: ${s.name} <${s.email}>`,
    `Sent: ${fmtDate("en", p.when, "outlook")}`,
    `To: ${to.name} <${to.email}>`,
    `Subject: ${prefix}${p.subject}`,
  ];
}

const REPLY_STYLES = ["gmail", "gmail", "gmail", "outlook", "outlook-orig", "apple", "thunderbird", "inline", "bottom"];

/** Appends the quote of `p` to `m` in `style`. */
function appendQuote(c: Ctx, m: Labelled, p: Msg, me: Person, style: string): void {
  const r = c.rng;
  if (style === "outlook" || style === "outlook-orig") {
    push(m, "", L_BLANK);
    if (style === "outlook") push(m, "________________________________", L_HEADER);
    else push(m, "-----Original Message-----", L_HEADER);
    for (const f of headerFields(c.lang, p, me, "outlook", "RE: ")) push(m, f, L_HEADER);
    push(m, "", L_BLANK);
    for (const l of p.item.text.split("\n")) push(m, l, L_QUOTE);
    return;
  }
  push(m, "", L_BLANK);
  for (const l of attribution(c.lang, style, p, r)) push(m, l, L_HEADER);
  if (style !== "thunderbird") push(m, "", L_BLANK);
  for (const l of quoteLines(p.item.text, r.chance(0.5) ? ">" : "> ")) push(m, l, L_QUOTE);
}

export interface CorpusOptions {
  threads: number;
  docs: number;
  notifications: number;
}

export function dedupCorpus(seed: number, options: CorpusOptions): Item[] {
  const r = new Rng(seed);
  const items: Item[] = [];
  let groups = 0;
  const people = PEOPLE.map((n) => makePerson(r, n));
  const add = (text: string, group: number, kind: string, m: Labelled | null, style: string): Item => {
    const item: Item = {
      id: items.length,
      text,
      group,
      kind,
      lines: m ? m.lines : null,
      labels: m ? m.labels : null,
      style,
    };
    items.push(item);
    return item;
  };
  const allMsgs: Msg[] = [];
  let clock = Date.UTC(2026, 8, 1, 9, 0);

  for (let t = 0; t < options.threads; t++) {
    const u = r.next();
    const lang: Lang = u < 0.6 ? "en" : u < 0.72 ? "fr" : u < 0.84 ? "de" : u < 0.94 ? "es" : "ja";
    const c: Ctx = { rng: r, lang };
    const a = r.pick(people);
    let b = r.pick(people);
    while (b === a) b = r.pick(people);
    const subject = fill(c, r.pick(["Re: {X}", "{X}", "Question about {X}", "{C} contract", "Next steps", "Trip"]));
    const length = 1 + r.int(6);
    let prev: Msg | null = null;
    const threadWidth = r.chance(0.4) ? 72 : 0;
    for (let k = 0; k < length; k++) {
      const sender = k % 2 === 0 ? a : b;
      const other = k % 2 === 0 ? b : a;
      clock += (1 + r.int(48)) * 3_600_000;
      const isAck = prev !== null && r.chance(0.15);
      const own: Own = {
        greeting: !isAck && r.chance(0.6) ? fill(c, r.pick(GREETINGS[lang]).replace("{P}", other.first)) : null,
        paras: isAck ? [] : body(c, 1),
        ack: isAck ? r.pick(ACKS[lang]) : null,
        sender,
      };
      const m: Labelled = { lines: [], labels: [] };
      let style = "none";
      if (prev === null) {
        renderOwn(c, own, threadWidth, m, true);
      } else {
        style = r.pick(REPLY_STYLES);
        if (style === "inline" && prev.own.paras.flat().length >= 2 && !isAck) {
          interleave(c, m, prev, own, threadWidth);
        } else if (style === "bottom" && !isAck) {
          appendQuote(c, m, prev, sender, "gmail");
          m.lines.shift(); // no leading blank line above the header
          m.labels.shift();
          push(m, "", L_BLANK);
          renderOwn(c, own, threadWidth, m, true);
        } else {
          if (style === "inline" || style === "bottom") style = "gmail";
          renderOwn(c, own, threadWidth, m, true);
          appendQuote(c, m, prev, sender, style);
        }
      }
      const group = isAck && prev !== null ? prev.item.group : groups++;
      const kind = prev === null ? "msg" : isAck ? "ack" : "reply";
      const item = add(m.lines.join("\n"), group, kind, m, style);
      const msg: Msg = { item, sender, subject, when: new Date(clock), lang, own };
      allMsgs.push(msg);
      prev = msg;
      // A synced copy of this message (another client, an archive, a CRM log).
      if (r.chance(0.2)) syncCopy(c, msg, m, add);
    }
  }

  // Forwards of earlier messages: bare, with "FYI", or with a real note (new information).
  const forwards = Math.round(options.threads * 0.4);
  for (let f = 0; f < forwards; f++) {
    const x = r.pick(allMsgs);
    const c: Ctx = { rng: r, lang: x.lang };
    const me = r.pick(people);
    const to = r.pick(people);
    const v = r.next();
    const m: Labelled = { lines: [], labels: [] };
    let kind: string;
    let group: number;
    if (v < 0.3) {
      kind = "fwd-bare";
      group = x.item.group;
    } else if (v < 0.65) {
      kind = "fwd-fyi";
      group = x.item.group;
      push(m, r.pick(FYI[x.lang]), L_OWN);
      push(m, "", L_BLANK);
    } else {
      kind = "fwd-note";
      group = groups++;
      renderOwn(c, { greeting: null, paras: body(c, 2), ack: null, sender: me }, 0, m, false);
      push(m, "", L_BLANK);
    }
    const style = r.pick(["gmail", "gmail", "apple", "outlook"]);
    if (style === "gmail") {
      push(m, "---------- Forwarded message ---------", L_HEADER);
      push(m, `From: ${x.sender.name} <${x.sender.email}>`, L_HEADER);
      push(m, `Date: ${fmtDate("en", x.when, "gmail")}`, L_HEADER);
      push(m, `Subject: ${x.subject}`, L_HEADER);
      push(m, `To: ${to.name} <${to.email}>`, L_HEADER);
      push(m, "", L_BLANK);
      push(m, "", L_BLANK);
    } else if (style === "apple") {
      push(m, "Begin forwarded message:", L_HEADER);
      push(m, "", L_BLANK);
      push(m, `From: ${x.sender.name} <${x.sender.email}>`, L_HEADER);
      push(m, `Subject: ${x.subject}`, L_HEADER);
      push(m, `Date: ${fmtDate("en", x.when, "gmail")}`, L_HEADER);
      push(m, `To: ${to.name} <${to.email}>`, L_HEADER);
      push(m, "", L_BLANK);
    } else {
      push(m, "________________________________", L_HEADER);
      for (const h of headerFields("en", x, to, "outlook", "FW: ")) push(m, h, L_HEADER);
      push(m, "", L_BLANK);
    }
    for (const l of x.item.text.split("\n")) push(m, l, L_FORWARD);
    add(m.lines.join("\n"), group, kind, m, style);
  }

  // Documents (meeting notes, specs, CRM notes) and their later versions.
  for (let d = 0; d < options.docs; d++) {
    const lang: Lang = r.chance(0.75) ? "en" : r.pick(["fr", "de", "es", "ja"] as const);
    const c: Ctx = { rng: r, lang };
    const sentences: string[] = [];
    const n = 6 + r.int(25);
    for (let i = 0; i < n; i++) sentences.push(sentence(c));
    const title = fill(c, r.pick(["Notes: {X}", "{C} account plan", "Spec: {X}", "Weekly sync {DATE}", "Trip plan"]));
    const asDoc = (s: string[], markdown: boolean) =>
      (markdown ? "# " : "") + title + "\n\n" + s.map((x, i) => (i % 4 === 0 ? "\n" : "") + "- " + x).join("\n");
    let group = groups++;
    add(asDoc(sentences, false), group, "doc", null, "doc");
    const versions = r.int(3);
    let current = sentences;
    for (let v = 0; v < versions; v++) {
      const next = current.slice();
      if (r.chance(0.6)) {
        // Minor: change or add one sentence, or fix a word.
        const op = r.int(3);
        if (op === 0) next[r.int(next.length)] = sentence(c);
        else if (op === 1) next.splice(r.int(next.length), 0, sentence(c));
        else next[0] = next[0]!.replace(/\b(\w+)\b/, "$1s");
        add(asDoc(next, r.chance(0.3)), group, "doc-minor", null, "doc");
      } else {
        // Major: about half the sentences rewritten.
        for (let i = 0; i < next.length; i++) if (r.chance(0.5)) next[i] = sentence(c);
        group = groups++; // later minor edits and copies are versions of this one
        add(asDoc(next, false), group, "doc-major", null, "doc");
      }
      current = next;
    }
    if (r.chance(0.3)) add(asDoc(current, true).replace(/\n/g, "\r\n"), group, "sync-doc", null, "doc");
  }

  // Templated notifications: same wording, different facts. Each is its own group.
  const templates = [
    "Your order #{ID} has shipped. It contains {N2} items and should arrive on {D}. Track your package at https://track.example.com/{ID}.",
    "Reminder: review of {X} with {P} starts at {T} on {D}. Join with Google Meet: https://meet.google.com/{ID}",
    "Invoice {ID} from {C} for {M} is due on {DATE}. Pay online or reply to this email with any questions.",
    "{P} commented on the doc for {X}: Can we tighten the timeline section before {D}?",
    "Your password was changed on {DATE} from a device in {CITY}. If this wasn't you, reset your password now.",
    "Updated invitation: sync on {X} @ {D} {T}. {P} has updated this event. Reply for {P2}@example.com.",
  ];
  for (let i = 0; i < options.notifications; i++) {
    const c: Ctx = { rng: r, lang: "en" };
    add(fill(c, templates[i % templates.length]!), groups++, "notif", null, "notif");
  }
  return items;
}

/** Interleaved reply: each quoted line of the previous message's own text followed by an answer. */
function interleave(c: Ctx, m: Labelled, p: Msg, own: Own, width: number): void {
  for (const l of attribution(c.lang, "gmail", p, c.rng)) push(m, l, L_HEADER);
  const sentences = p.own.paras.flat();
  const mine = own.paras.flat();
  sentences.forEach((s, i) => {
    push(m, "> " + s, L_QUOTE);
    if (i < mine.length) {
      push(m, "", L_BLANK);
      for (const l of width > 0 ? wrap(mine[i]!, width) : [mine[i]!]) push(m, l, L_OWN);
      push(m, "", L_BLANK);
    }
  });
  for (let i = sentences.length; i < mine.length; i++) push(m, mine[i]!, L_OWN);
  push(m, "", L_BLANK);
  renderOwn(c, { greeting: null, paras: [], ack: null, sender: own.sender }, 0, m, true);
}

/** A copy of `msg` as another client or system would store it. Same group; not line-labelled. */
function syncCopy(
  c: Ctx,
  msg: Msg,
  m: Labelled,
  add: (text: string, group: number, kind: string, m: Labelled | null, style: string) => Item,
): void {
  const r = c.rng;
  const text = msg.item.text;
  const v = r.int(6);
  if (v === 0) add(text.replace(/\n/g, "\r\n"), msg.item.group, "sync-crlf", null, "sync");
  else if (v === 1) {
    // Rewrapped own text: a client that stores flowed text, or one that hard-wraps at 72.
    const lines: string[] = [];
    let para = "";
    for (let i = 0; i < m.lines.length; i++) {
      const label = m.labels[i]!;
      if (label === L_OWN && m.lines[i]!.trim() !== "") para += (para ? " " : "") + m.lines[i];
      else {
        if (para) lines.push(...wrap(para, para.length > 72 && r.chance(0.5) ? 60 : 1_000));
        para = "";
        lines.push(m.lines[i]!);
      }
    }
    if (para) lines.push(...wrap(para, 60));
    add(lines.join("\n"), msg.item.group, "sync-wrap", null, "sync");
  } else if (v === 2) add(text.normalize("NFD"), msg.item.group, "sync-nfd", null, "sync");
  else if (v === 3) {
    const smart = text.replace(/'/g, "’").replace(/ ([?!:;])/g, " $1");
    add(smart, msg.item.group, "sync-smart", null, "sync");
  } else if (v === 4) {
    const footer =
      '\n\n-- \nYou received this message because you are subscribed to the Google Groups "team" group.\n' +
      "To unsubscribe from this group and stop receiving emails from it, send an email to team+unsubscribe@googlegroups.com.";
    add(text + footer, msg.item.group, "sync-list", null, "sync");
  } else {
    const s = msg.sender;
    const header = `From: ${s.name} <${s.email}>\nDate: ${msg.when.toISOString()}\nSubject: ${msg.subject}\n\n`;
    add(header + text, msg.item.group, "sync-crm", null, "sync");
  }
}
