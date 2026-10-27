/**
 * Email reply structure for dedup: which lines of a message are the sender's own words, and which are a quoted earlier
 * message, a reply header, a forwarded message, a signature or a greeting. Dedup compares own words; a reply that adds
 * nothing ("Thanks!") or a forward without a note is compared by what it carries instead (`dedupText`).
 *
 * Plain text only, line based, no model. Covers, in the languages Gmail, Outlook, Apple Mail, Thunderbird and others
 * write them:
 * - `>` quoted lines (any depth; interleaved and bottom-posted replies keep their unquoted lines as own text);
 * - attribution headers ("On … wrote:", "Le … a écrit :", "Am … schrieb …:", "… 写道：", Gmail's verb-less
 *   "<date> <name> <email>:"), also wrapped over up to three lines or wrapped in dashes (Zoho); with no `>` below
 *   them, everything below is quoted (Outlook, Apple, converted HTML);
 * - "-----Original Message-----" separators and Outlook "From: … Sent: …" header blocks (everything below is quoted);
 * - forward markers ("---------- Forwarded message ---------", "Begin forwarded message:") and the fields under them;
 * - "-- " and "__" signature delimiters (mailing-list footers too), mobile footers ("Sent from my iPhone") and
 *   closings ("Thanks,\nDana") near the end of the text;
 * - an opening greeting line ("Hi Dana,").
 * HTML mail is out of scope: convert it to text first (most converters turn blockquotes into `>` lines).
 *
 * Why not a library (docs/research/primitives-dedup.md): the JS parsers either keep forwarded and short quotes as
 * content (planer, talonjs: built to show a reply, not to dedup it), run 100x slower (email-reply-parser), or
 * backtrack for seconds on one long line (planer); none reports per-line kinds. This is a rewrite, not a port; the
 * header phrasings were checked against those projects' fixtures.
 *
 * Per message, not per token: it slices only candidate lines (ending with a colon or a reply verb, starting with a
 * field name or a dash) and runs a few regexes on them: microseconds per KB, linear in the worst case
 * (bench/dedup.bench.ts).
 */
import { CLASS, classOf, WORD_START } from "./charclass";
import { isUnsegmented } from "./dedup";

/** The sender's own words. */
export const PART_OWN = 0;
/** A quoted earlier message: `>` lines, or the unmarked text under a reply header or an Outlook header block. */
export const PART_QUOTE = 1;
/** A reply attribution line, an "Original Message" separator, or header fields (From:, Sent:, Subject:, …). */
export const PART_HEADER = 2;
/** A forwarded message (below a forward marker and its header fields). */
export const PART_FORWARD = 3;
/** A signature (after "-- " or "__"), a mobile footer, or a closing with the name under it. */
export const PART_SIGNATURE = 4;
/** An opening greeting line ("Hi Dana,"). */
export const PART_GREETING = 5;

/** Per-line output of `splitReply`: line `i` is `text.slice(starts[i], ends[i])` (no newline, no trailing \r). */
export class ReplyLines {
  count = 0;
  starts: Uint32Array;
  ends: Uint32Array;
  kinds: Uint8Array;

  constructor(capacity: number) {
    const n = Math.max(16, capacity);
    this.starts = new Uint32Array(n);
    this.ends = new Uint32Array(n);
    this.kinds = new Uint8Array(n);
  }

  /** Makes room for `n` lines (contents are not kept). */
  reserve(n: number): void {
    if (n <= this.starts.length) return;
    let size = this.starts.length;
    while (size < n) size *= 2;
    this.starts = new Uint32Array(size);
    this.ends = new Uint32Array(size);
    this.kinds = new Uint8Array(size);
  }
}

// Header candidates longer than this are prose, not headers (a wrapped Gmail header is ~150 characters).
const MAX_HEADER_CHARS = 400;
// A line of a wrapped header is shorter than this.
const MAX_WRAPPED_LINE = 200;
// Signature delimiters, footers and closings only count near the end of a block of own text. Delimited signatures
// can be long (a legal disclaimer), closings and footers are short.
const SIGNATURE_LINES = 20;
const FOOTER_LINES = 4;
const CLOSING_LINES = 6;
const CLOSING_TAIL_LINES = 5;
const CLOSING_TAIL_CHARS = 60;
// Outlook header blocks: fields within this many lines of From:, and wrapped continuation lines before the second.
const HEADER_BLOCK_LINES = 8;
const HEADER_CONTINUATION_LINES = 2;
// Levels of quoted or forwarded messages `dedupText` descends through; each level costs one more split.
const MAX_CARRIED_DEPTH = 8;

/** A reply verb right before the final colon ("… wrote:", "… a écrit :", "… 写道："). */
const ATTRIBUTION_END =
  /(?:wrote|writes|a écrit|écrit|escribió|escreveu|escrevia|scritto|schrieb|geschrieben|schreef|geschreven|skrev|skrifaði|kirjoitti|napisał\(a\)|napisała|napisał|pisze|написал\(а\)|написала|написал|napsal\(a\)|napsal|írta|yazdı|a scris|έγραψε|写道|寫道|のメッセージ|書きました|작성)\s*[:：]\s*$/iu;
/** The same verbs at the very end of a line without a colon ("On … wrote", Zoho's "---- On … wrote ----"). */
const ATTRIBUTION_BARE_END =
  /(?:wrote|a écrit|escribió|escreveu|scritto|schrieb|schreef|skrev|kirjoitti|napisał|írta)[\s-]*$/iu;
/** A header that opens with a date phrase ("On", "Le", "Am", …). */
const ATTRIBUTION_OPENER = /^(?:On|Le|El|Em|Il|Am|Op|Den|På|W dniu|Dnia|Dne|В|Στις)\s/u;
const ATTRIBUTION_VERB =
  /(?:^|[\s,])(?:wrote|a écrit|escribió|escreveu|scritto|schrieb|schreef|skrev|kirjoitti|napisał|pisze|написал|napsal|írta)(?=$|[\s:：,(])/iu;
/** Ends with "<email>:" (tolerating a wrapped "<a@b.c\n>:"). */
const ATTRIBUTION_EMAIL_END = /<[^<>\s@]+@[^<>\s]+\s*>\)?\s*[:：]\s*$/u;
const TIME = /\d{1,2}[:.h]\d{2}/;
const DIGIT = /\d/;
const ADDRESS = /[@<]/;

const ORIGINAL_MESSAGE =
  /^[-–—]{2,}\s*(?:Original Message|Reply Message|Ursprüngliche Nachricht|Message d'origine|Message d’origine|Mensaje original|Messaggio originale|Mensagem original|Oorspronkelijk bericht|Oprindelig meddelelse|Oprindelig besked|Opprinnelig melding|Ursprungligt meddelande|Alkuperäinen viesti|Wiadomość oryginalna|Oryginalna wiadomość|Исходное сообщение|Původní zpráva|Eredeti üzenet|原始邮件|元のメッセージ)\s*[-–—]{2,}\s*$/iu;
const FORWARD_RULE =
  /^[-–—]{2,}\s*(?:Forwarded message|Forwarded Message|Weitergeleitete Nachricht|Message transféré|Mensaje reenviado|Messaggio inoltrato|Mensagem encaminhada|Mensagem reencaminhada|Doorgestuurd bericht|Videresendt meddelelse|Videresendt melding|Vidarebefordrat meddelande|Przekazana wiadomość|Wiadomość przekazana dalej|Пересылаемое сообщение|Välitetty viesti|转发的邮件|転送されたメッセージ|전달된 메시지)\s*[-–—]{2,}\s*$/iu;
const FORWARD_LINE =
  /^(?:Begin forwarded message|Anfang der weitergeleiteten Nachricht|Début du message réexpédié|Début du message transféré|Inicio del mensaje reenviado|Inizio messaggio inoltrato|Início da mensagem reencaminhada|Begin doorgestuurd bericht)\s*[:：]\s*$/iu;

/** A header field line, in any of the languages above; `*` around the name is Gmail's HTML-to-text bold. */
const FIELD =
  /^\*?(?:From|Sent|Date|To|Cc|Bcc|Subject|Reply-To|De|Envoyé le|Envoyé|À|Objet|Sujet|Copie à|Von|Gesendet|An|Betreff|Datum|Van|Verzonden|Aan|Onderwerp|Da|Inviato|A|Oggetto|Enviado|Para|Asunto|Fecha|Assunto|Data|Från|Skickat|Till|Ämne|Fra|Sendt|Dato|Til|Emne|Od|Wysłano|Do|Temat|Lähettäjä|Lähetetty|Vastaanottaja|Aihe|От|Отправлено|Кому|Тема|Дата|发件人|发送时间|收件人|抄送|主题|日期|寄件者|差出人|送信日時|宛先|件名|보낸 사람|받는 사람|날짜|제목)\*?[ \t]*[:：]/iu;
const FROM_FIELD = /^\*?(?:From|De|Von|Van|Da|Från|Fra|Od|Lähettäjä|От|发件人|寄件者|差出人|보낸 사람)\*?[ \t]*[:：]/iu;
/** A line of only separator characters ("________", "------", "===="). */
const SEPARATOR = /^[-_=*~—–]{4,}$/;
/** A short "Label :" line, such as "Message du : 12/12/2016" above some clients' header blocks. */
const LABEL_LINE = /^[\p{L} ]{2,24}[:：]/u;

const MOBILE_FOOTER =
  /^(?:Sent from |Sent with (?:Proton|BlackBerry)|Get Outlook for |Envoyé de mon |Envoyé depuis |Envoyé à partir de |Télécharger Outlook pour |Von meinem .{1,40} gesendet|Gesendet von (?:meinem|Mail|Outlook)|Holen Sie sich Outlook für |Enviado desde mi |Enviado desde |Enviado do meu |Enviado do |Obtener Outlook para |Inviato da(?:l mio)? |Scarica Outlook per |Verzonden (?:vanaf|met) |Verstuurd vanaf |Skickat från |Sendt fra |Wysłane z (?:mojego )?|Отправлено с |.{1,30}から送信$)/iu;
const CLOSING =
  /^(?:thanks|thank you|many thanks|thanks again|thx|ty|cheers|best|best regards|kind regards|warm regards|warmly|regards|all the best|all best|sincerely|yours|yours sincerely|talk soon|speak soon|merci|merci beaucoup|cordialement|bien cordialement|bien à vous|bonne journée|à bientôt|amitiés|bises|danke|vielen dank|viele grüße|liebe grüße|beste grüße|mit freundlichen grüßen|freundliche grüße|lg|vg|gruß|grüße|gracias|muchas gracias|saludos|un saludo|un abrazo|atentamente|grazie|grazie mille|cordiali saluti|saluti|un saluto|obrigado|obrigada|abraços|atenciosamente|bedankt|groeten|met vriendelijke groet|hartelijke groet|mvh|med vänliga hälsningar|vänliga hälsningar|hälsningar|tack|pozdrawiam|dziękuję|с уважением|спасибо|よろしくお願いします|よろしくお願いいたします|宜しくお願いします|谢谢|감사합니다)[\s,.!。！~-]*$/iu;
const GREETING =
  /^(?:hi|hello|hey|hiya|dear|greetings|good (?:morning|afternoon|evening)|bonjour|bonsoir|salut|cher|chère|chers|hallo|liebe|lieber|liebes|sehr geehrte|sehr geehrter|guten (?:morgen|tag|abend)|moin|servus|hola|buenos días|buenas tardes|buenas|estimado|estimada|estimados|querido|querida|ciao|buongiorno|buonasera|gentile|caro|cara|olá|oi|prezado|prezada|beste|hoi|hej|hei|cześć|dzień dobry|здравствуйте|привет|добрый день)(?:[\s,!:]|$)[^.?!\n]{0,40}$/iu;

const isQuoteChar = (c: number) => c === 62 || c === 0xff1e; // > and the full-width ＞

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 13 || c === 0xa0 || c === 0x3000 || c === 0xfeff || c === 0x200b;
}

/** Line state shared by the passes: first and last non-space offsets per line (-1 for a blank line). */
let firsts = new Int32Array(64);
let lasts = new Int32Array(64);

/**
 * Splits `text` into lines and labels each with a PART_* kind. Returns the line count. With `boilerplate` false,
 * greetings, closings and footers stay PART_OWN (delimited signatures are still labelled).
 */
export function splitReply(text: string, out: ReplyLines, boilerplate: boolean): number {
  const n = lineCount(text);
  out.reserve(n);
  if (firsts.length < n) {
    firsts = new Int32Array(Math.max(n, firsts.length * 2));
    lasts = new Int32Array(firsts.length);
  }
  const count = scanLines(text, out);
  markSplitter(text, out, count);
  // In each run of own lines: signatures, footers and closings at its end, and a greeting at the start of the first.
  let runStart = -1;
  let firstRun = true;
  for (let i = 0; i <= count; i++) {
    // A run starts at a line with content; blank lines inside it belong to it.
    const own = i < count && out.kinds[i] === PART_OWN && (firsts[i]! >= 0 || runStart >= 0);
    if (own) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      markTail(text, out, runStart, i, boilerplate);
      if (firstRun && boilerplate) markGreeting(text, out, runStart, i);
      firstRun = false;
      runStart = -1;
    }
  }
  return count;
}

/** Line bounds, blank lines, `>` quotes. */
function scanLines(text: string, out: ReplyLines): number {
  let count = 0;
  let pos = 0;
  for (;;) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    const next = end + 1;
    if (end > pos && text.charCodeAt(end - 1) === 13) end--;
    out.starts[count] = pos;
    out.ends[count] = end;
    let f = pos;
    while (f < end && isSpace(text.charCodeAt(f))) f++;
    let l = end - 1;
    while (l >= f && isSpace(text.charCodeAt(l))) l--;
    firsts[count] = f < end ? f : -1;
    lasts[count] = f < end ? l : -1;
    // ">:" alone is the tail of a header wrapped inside "<a@b.c>", not a quote.
    const quote = f < end && isQuoteChar(text.charCodeAt(f)) && !(l === f + 1 && text.charCodeAt(l) === 58);
    out.kinds[count] = quote ? PART_QUOTE : PART_OWN;
    count++;
    if (next > text.length) break;
    pos = next;
  }
  out.count = count;
  return count;
}

/** The first splitter (separator, forward marker, attribution, header block) decides what follows it. */
function markSplitter(text: string, out: ReplyLines, count: number): void {
  const kinds = out.kinds;
  for (let i = 0; i < count; i++) {
    if (kinds[i] !== PART_OWN || firsts[i]! < 0) continue;
    const f = firsts[i]!;
    const l = lasts[i]!;
    const c0 = text.charCodeAt(f);
    const cl = text.charCodeAt(l);
    if (l - f >= MAX_HEADER_CHARS) continue;

    if ((c0 === 45 || c0 === 0x2013 || c0 === 0x2014) && l - f >= 4) {
      const line = piece(text, f, l + 1);
      if (FORWARD_RULE.test(line)) {
        markForward(text, out, i);
        return;
      }
      if (ORIGINAL_MESSAGE.test(line)) {
        kinds[i] = PART_HEADER;
        fillFrom(out, markHeaderFields(text, out, i + 1, count), PART_QUOTE);
        return;
      }
    }
    const colon = cl === 58 || cl === 0xff1a;
    if (colon && FORWARD_LINE.test(piece(text, f, l + 1))) {
      markForward(text, out, i);
      return;
    }
    // A header without a colon ("On … wrote") is tested only when its first and last letters allow it: this
    // check runs on every line, the regex on few.
    const bare = !colon && cl !== 45 && OPENER_FIRST.has(c0) && VERB_LAST.has(cl < 128 ? cl | 32 : cl);
    if (colon || cl === 45 || (bare && ATTRIBUTION_BARE_END.test(piece(text, Math.max(f, l - 23), l + 1)))) {
      const start = attributionStart(text, out, i);
      if (start >= 0) {
        for (let j = start; j <= i; j++) kinds[j] = PART_HEADER;
        // Marked (`>` follows): only `>` lines are quoted, so interleaved answers and bottom posts stay own text.
        // Unmarked (Outlook, Apple, converted HTML): everything below the header is the quoted message.
        if (nextContentKind(out, i + 1, count) !== PART_QUOTE) {
          fillFrom(out, i + 1, PART_QUOTE);
          return;
        }
        continue;
      }
    }
    const head = Math.min(l + 1, f + 24);
    if (l - f >= 3 && colonWithin(text, f, head) && FROM_FIELD.test(piece(text, f, head))) {
      const last = headerBlockEnd(text, out, i, count);
      if (last > i) {
        markLabelsAbove(text, out, i);
        for (let j = i; j <= last; j++) kinds[j] = PART_HEADER;
        fillFrom(out, last + 1, PART_QUOTE);
        return;
      }
    }
  }
}

/** First letters of the header openers ("On", "Le", "El", "Em", "Il", "Am", "Op", "Den", "På", "W dniu", …). */
const OPENER_FIRST = new Set([..."OLEIAPDWВΣ"].map((c) => c.charCodeAt(0)));
/** Last letters (lowercased) of the verbs in ATTRIBUTION_BARE_END. */
const VERB_LAST = new Set([..."etóuobfviła"].map((c) => c.charCodeAt(0)));

function colonWithin(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === 58 || c === 0xff1a) return true;
  }
  return false;
}

function lineCount(text: string): number {
  let n = 1;
  for (let p = text.indexOf("\n"); p >= 0; p = text.indexOf("\n", p + 1)) n++;
  return n;
}

function fillFrom(out: ReplyLines, from: number, kind: number): void {
  for (let j = from; j < out.count; j++) out.kinds[j] = kind;
}

/** The kind of the first non-blank line at or after `from`, or -1. */
function nextContentKind(out: ReplyLines, from: number, count: number): number {
  for (let j = from; j < count; j++) if (firsts[j]! >= 0) return out.kinds[j]!;
  return -1;
}

/**
 * If line `i` ends an attribution header, the index of the header's first line (clients wrap it over up to three
 * lines); otherwise -1. Tries, in order: a start line that opens like a header ("On …"), line `i` alone, then the
 * wrapped lines above it (lines that do not end a sentence).
 */
function attributionStart(text: string, out: ReplyLines, i: number): number {
  let earliest = i;
  for (let k = 1; k <= 2; k++) {
    const j = i - k;
    if (j < 0 || firsts[j]! < 0 || out.kinds[j] !== PART_OWN) break;
    if (lasts[j]! - firsts[j]! >= MAX_WRAPPED_LINE) break;
    const c = text.charCodeAt(lasts[j]!);
    if (c === 46 || c === 33 || c === 63 || c === 0x3002) break; // a sentence ends here: prose, not a header
    earliest = j;
  }
  // Every form needs a reply verb somewhere or "<email>:" at the end: reject the rest (a "Label:" list) cheaply.
  let verb = ATTRIBUTION_END.test(piece(text, firsts[i]!, lasts[i]! + 1));
  for (let s = earliest; s <= i && !verb; s++) verb = ATTRIBUTION_VERB.test(piece(text, firsts[s]!, lasts[s]! + 1));
  if (!verb && !endsWithAddress(text, i)) return -1;
  const quoteBelow = nextContentKind(out, i + 1, out.count) === PART_QUOTE;
  for (let s = earliest; s < i; s++) {
    if (!ATTRIBUTION_OPENER.test(piece(text, firsts[s]!, Math.min(lasts[s]! + 1, firsts[s]! + 12)))) continue;
    if (isAttribution(joinLines(text, s, i), quoteBelow)) return s;
  }
  if (isAttribution(joinLines(text, i, i), quoteBelow)) {
    // "pe 20. lokakuuta 2017 klo 17.50 John Coe" / "<j@x.com> kirjoitti:": wrapped lines with a date or an address.
    for (let s = earliest; s < i; s++) if (headerish(text, s, i - 1)) return s;
    return i;
  }
  for (let s = i - 1; s >= earliest; s--) if (isAttribution(joinLines(text, s, i), quoteBelow)) return s;
  return -1;
}

/** Whether line `i` ends with ">:" or ">):" (an address closing a header), ignoring spaces before the colon. */
function endsWithAddress(text: string, i: number): boolean {
  let k = lasts[i]!;
  const c = text.charCodeAt(k);
  if (c !== 58 && c !== 0xff1a) return false;
  k--;
  while (k >= firsts[i]! && isSpace(text.charCodeAt(k))) k--;
  if (k >= firsts[i]! && text.charCodeAt(k) === 41) k--; // ")"
  return k >= firsts[i]! && text.charCodeAt(k) === 62;
}

function headerish(text: string, s: number, e: number): boolean {
  for (let j = s; j <= e; j++) {
    const line = text.slice(firsts[j]!, lasts[j]! + 1);
    if (!DIGIT.test(line) && !ADDRESS.test(line)) return false;
  }
  return true;
}

/** Whether `h` (a header candidate, joined and stripped of surrounding dashes) is a reply attribution. */
function isAttribution(h: string, quoteBelow: boolean): boolean {
  if (h.length === 0 || h.length > MAX_HEADER_CHARS) return false;
  if (ATTRIBUTION_END.test(h)) return true; // "… wrote:", "… a écrit :", "… 写道："
  const verb = ATTRIBUTION_VERB.test(h);
  if (verb && ATTRIBUTION_OPENER.test(h)) return true; // "On … wrote", "Am …, schrieb Dana <d@x>:"
  const colon = h.endsWith(":") || h.endsWith("：");
  if (verb && colon && DIGIT.test(h) && ADDRESS.test(h)) return true; // "tir. 18. apr. 2017 kl. 13:09 skrev X <x@y>:"
  // Verb-less ("2026年10月27日(火) 15:14 Dana <d@x>:", "30.09.2017, 18.30, "John" <j@x>:"): with `>` quotes below,
  // or with a time of day in it; "… <a@b.c>:" alone could be prose.
  return ATTRIBUTION_EMAIL_END.test(h) && (quoteBelow || TIME.test(h));
}

/** Lines s..e (inclusive) joined by spaces, NFC, without the dashes some clients put around a header. */
function joinLines(text: string, s: number, e: number): string {
  let out = "";
  for (let j = s; j <= e; j++) out += (j > s ? " " : "") + text.slice(firsts[j]!, lasts[j]! + 1);
  return out
    .replace(/^[-–—\s]+|[-–—\s]+$/g, "")
    .replace(/\s+>/g, ">")
    .normalize("NFC");
}

/**
 * `text[start, end)` in NFC, for the regexes: they are written in composed form, and text that arrives decomposed
 * (macOS, some IMAP stores: "e" + U+0301) would otherwise miss "a écrit". Only candidate lines are sliced.
 */
function piece(text: string, start: number, end: number): string {
  return text.slice(start, end).normalize("NFC");
}

function isField(text: string, j: number): boolean {
  return FIELD.test(piece(text, firsts[j]!, Math.min(lasts[j]! + 1, firsts[j]! + 24)));
}

/** Line `i` is a From: field. The last line of the header block it starts, or -1 if it is not one. */
function headerBlockEnd(text: string, out: ReplyLines, i: number, count: number): number {
  let last = -1;
  let seen = 0;
  let continuation = 0;
  for (let j = i + 1; j < count && j <= i + HEADER_BLOCK_LINES; j++) {
    if (firsts[j]! < 0) {
      if (seen > 0) break; // Outlook ends the block with a blank line
      continue;
    }
    if (isField(text, j)) {
      seen++;
      last = j;
    } else if (seen === 0 && ++continuation > HEADER_CONTINUATION_LINES) {
      return -1; // a long From: value wraps over a line or two ("<a-very-long-address@…>"), prose does not stop
    }
  }
  return seen > 0 ? last : -1;
}

/** Above a header block at `i`: separator lines and short "Label :" lines ("Message du : …") belong to it. */
function markLabelsAbove(text: string, out: ReplyLines, i: number): void {
  for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
    if (out.kinds[j] !== PART_OWN) return;
    if (firsts[j]! < 0) continue;
    const line = piece(text, firsts[j]!, lasts[j]! + 1);
    if (!SEPARATOR.test(line) && !(line.length < 80 && LABEL_LINE.test(line))) return;
    out.kinds[j] = PART_HEADER;
  }
}

/** Labels header-field lines (and blank lines among them) from `from` as PART_HEADER; returns the next line. */
function markHeaderFields(text: string, out: ReplyLines, from: number, count: number): number {
  let j = from;
  let fields = 0;
  for (; j < count; j++) {
    if (firsts[j]! < 0) {
      if (fields > 0) break;
      out.kinds[j] = PART_HEADER;
      continue;
    }
    if (!isField(text, j)) break;
    out.kinds[j] = PART_HEADER;
    fields++;
  }
  return j;
}

function markForward(text: string, out: ReplyLines, i: number): void {
  out.kinds[i] = PART_HEADER;
  fillFrom(out, markHeaderFields(text, out, i + 1, out.count), PART_FORWARD);
}

/** "--" (RFC 3676's "-- " once trailing spaces are trimmed) or "__" (mailing-list footers): a signature delimiter. */
function isDelimiter(text: string, j: number): boolean {
  const f = firsts[j]!;
  const c = text.charCodeAt(f);
  if (c !== 45 && c !== 95) return false;
  const l = lasts[j]!;
  if (c === 45) return l === f + 1 && text.charCodeAt(l) === 45;
  for (let k = f + 1; k <= l; k++) if (text.charCodeAt(k) !== 95) return false;
  return l > f;
}

/** Signature, footer or closing at the end of the own run [start, end). */
function markTail(text: string, out: ReplyLines, start: number, end: number, boilerplate: boolean): void {
  // First the delimiter: everything below it is signature, however long (a disclaimer, a mailing-list footer).
  // The earliest one in the window wins.
  let cut = end;
  let seen = 0;
  for (let j = end - 1; j >= start && seen < SIGNATURE_LINES; j--) {
    if (firsts[j]! < 0) continue;
    seen++;
    if (isDelimiter(text, j)) cut = j;
  }
  // Then, above it, a mobile footer or a closing. A closing counts only if what is below it (up to the delimiter)
  // is a few short lines (a name, a title, a phone number) and there is text above it: "Thanks!" alone is the
  // message, not its sign-off.
  if (boilerplate) {
    let tailOk = true;
    seen = 0;
    for (let j = cut - 1; j >= start && seen < CLOSING_LINES; j--) {
      if (firsts[j]! < 0) continue;
      seen++;
      const f = firsts[j]!;
      const l = lasts[j]!;
      if (seen <= FOOTER_LINES && l - f < 100 && MOBILE_FOOTER.test(piece(text, f, l + 1))) cut = j;
      else if (tailOk && l - f < 40 && CLOSING.test(piece(text, f, l + 1)) && hasOwnAbove(out, start, j)) cut = j;
      if (l - f + 1 > CLOSING_TAIL_CHARS || seen > CLOSING_TAIL_LINES) tailOk = false;
    }
  }
  for (let j = cut; j < end; j++) if (firsts[j]! >= 0) out.kinds[j] = PART_SIGNATURE;
}

function hasOwnAbove(out: ReplyLines, start: number, j: number): boolean {
  for (let k = j - 1; k >= start; k--) if (firsts[k]! >= 0 && out.kinds[k] === PART_OWN) return true;
  return false;
}

function markGreeting(text: string, out: ReplyLines, start: number, end: number): void {
  for (let j = start; j < end; j++) {
    if (firsts[j]! < 0) continue;
    if (out.kinds[j] !== PART_OWN) return;
    const f = firsts[j]!;
    const l = lasts[j]!;
    if (l - f < 60 && GREETING.test(piece(text, f, l + 1))) out.kinds[j] = PART_GREETING;
    return;
  }
}

const shared = new ReplyLines(256);

/** The own lines of `text`, joined by "\n", without leading or trailing blank lines. */
export function stripReply(text: string): string {
  const count = splitReply(text, shared, true);
  return joinKind(text, shared, count, PART_OWN);
}

function joinKind(text: string, lines: ReplyLines, count: number, kind: number): string {
  let out = "";
  let pendingBlank = false;
  for (let i = 0; i < count; i++) {
    if (lines.kinds[i] !== kind) continue;
    const s = lines.starts[i]!;
    const e = lines.ends[i]!;
    if (!hasContent(text, s, e)) {
      if (out.length > 0) pendingBlank = true;
      continue;
    }
    if (out.length > 0) out += pendingBlank ? "\n\n" : "\n";
    pendingBlank = false;
    out += text.slice(s, e);
  }
  return out;
}

function hasContent(text: string, s: number, e: number): boolean {
  for (let i = s; i < e; i++) if (!isSpace(text.charCodeAt(i))) return true;
  return false;
}

/**
 * Approximate word count of `text`: runs that start with a letter or digit, as the tokenizer starts terms, except
 * that scripts written without spaces (Chinese, Japanese, Thai) count one word per two characters, the typical word
 * length there (the tokenizer would make a whole sentence one term).
 */
export function countTerms(text: string): number {
  let n = 0;
  let unsegmented = 0;
  let inTerm = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x0e00 && isUnsegmented(c)) {
      unsegmented++;
      inTerm = false;
      continue;
    }
    const start = ((c < 128 ? CLASS[c]! : classOf(c)) & WORD_START) !== 0;
    if (start && !inTerm) n++;
    inTerm = start || (inTerm && (c === 39 || c === 45 || c === 95 || c === 0x2019));
  }
  return n + ((unsegmented + 1) >> 1);
}

/**
 * The text to compare for dedup: the own words, or, when they are fewer than `minOwnTerms` terms (an
 * acknowledgement, "FYI", a bare forward), the message it quotes or forwards, itself reduced the same way (up to
 * MAX_CARRIED_DEPTH levels: a forward of "Thanks!" quoting "Got it" quoting the message). A reply that adds words is
 * new content; one that adds none is a copy of what it carries. 6 measured best on the dedup corpus (3 to 10 were
 * within a few points; docs/research/primitives-dedup.md).
 */
export function dedupText(text: string, minOwnTerms: number): string {
  let current = text;
  for (let depth = 0; ; depth++) {
    const count = splitReply(current, shared, true);
    const own = joinKind(current, shared, count, PART_OWN);
    if (depth === MAX_CARRIED_DEPTH || countTerms(own) >= minOwnTerms) return own;
    const carried = carriedMessage(current, shared, count);
    if (carried.length === 0) return own;
    current = carried;
  }
}

/** The first quoted or forwarded message in `text`, with one level of `>` removed. */
function carriedMessage(text: string, lines: ReplyLines, count: number): string {
  let i = 0;
  while (i < count && lines.kinds[i] !== PART_QUOTE && lines.kinds[i] !== PART_FORWARD) i++;
  if (i === count) return "";
  const kind = lines.kinds[i]!;
  // Only a `>`-marked block loses a level of `>`; an unmarked one (under an Outlook header) is copied as it is.
  const marked = kind === PART_QUOTE && isQuoteChar(firstChar(text, lines.starts[i]!, lines.ends[i]!));
  let out = "";
  for (; i < count; i++) {
    const k = lines.kinds[i]!;
    const s = lines.starts[i]!;
    const e = lines.ends[i]!;
    if (k !== kind) {
      // A blank line inside a quote block belongs to it; anything else ends the carried message.
      if (k === PART_OWN && !hasContent(text, s, e)) {
        out += "\n";
        continue;
      }
      break;
    }
    out += (marked ? dequote(text, s, e) : text.slice(s, e)) + "\n";
  }
  return out;
}

function firstChar(text: string, s: number, e: number): number {
  while (s < e && isSpace(text.charCodeAt(s))) s++;
  return s < e ? text.charCodeAt(s) : -1;
}

/** `text[s, e)` without its first `>` (and one space after it). */
function dequote(text: string, s: number, e: number): string {
  let i = s;
  while (i < e && isSpace(text.charCodeAt(i))) i++;
  if (i < e && isQuoteChar(text.charCodeAt(i))) {
    i++;
    if (i < e && text.charCodeAt(i) === 32) i++;
    return text.slice(i, e);
  }
  return text.slice(s, e);
}
