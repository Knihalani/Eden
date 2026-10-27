/**
 * The reply stripper on real emails from other projects' test suites, not on our generator's output:
 *
 * - email-reply-parser's 90 fixtures (crisp-oss/email-reply-parser@340eff4, test/fixtures/*.txt): our output
 *   against that library's, listing the fixtures where they differ for review by hand. These fixtures were used
 *   while developing reply.ts (they exposed real gaps), so they are not a held-out score.
 * - talon's 12 standard replies (mailgun/talon@44d1fa5, tests/fixtures/standard_replies/*.eml), held out: never
 *   looked at before the stripper was final. Expected text is talon's (the `_reply_text` file, else "Hello"); talon
 *   keeps greetings, so ours is scored with boilerplate stripping off as well as on.
 *
 *   cd $LIBEVAL && mkdir -p fixtures && git clone https://github.com/crisp-oss/email-reply-parser fixtures/erp \
 *     && git clone https://github.com/mailgun/talon fixtures/talon   # plus the packages of dedup.compare.ts
 *   LIBEVAL=/tmp/libeval bun packages/primitives/bench/compare/reply-fixtures.compare.ts [--show]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PART_OWN, ReplyLines, splitReply, stripReply } from "../../src/reply";

const dir = process.env.LIBEVAL;
if (!dir) throw new Error("set LIBEVAL to the directory with the libraries and fixtures");
const req = createRequire(join(dir, "package.json"));
const EmailReplyParser = (await import(join(dir, "node_modules/email-reply-parser/dist/emailreplyparser.js"))).default;
const planer = req("planer");
const talon = req("talonjs");
const show = process.argv.includes("--show");

const norm = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
const lines = new ReplyLines(64);
const ownWithBoilerplate = (t: string) => {
  const n = splitReply(t, lines, false);
  const out: string[] = [];
  for (let i = 0; i < n; i++) if (lines.kinds[i] === PART_OWN) out.push(t.slice(lines.starts[i]!, lines.ends[i]!));
  return out.join("\n");
};
const erp = (t: string) => new EmailReplyParser().read(t).getVisibleText() as string;

console.log("## email-reply-parser fixtures: our stripReply against email-reply-parser's visible text");
const erpDir = join(dir, "fixtures/erp/test/fixtures");
const files = readdirSync(erpDir)
  .filter((f) => f.endsWith(".txt"))
  .sort();
const differ: string[] = [];
for (const f of files) {
  const text = readFileSync(join(erpDir, f), "utf8");
  const ours = stripReply(text);
  const theirs = erp(text);
  if (norm(ours) === norm(theirs)) continue;
  differ.push(f);
  if (show) console.log(`\n### ${f}\n--- ours\n${ours}\n--- email-reply-parser\n${theirs}`);
}
console.log(`${files.length} fixtures, identical ${files.length - differ.length}, different: ${differ.join(", ")}`);

console.log("\n## talon standard replies (held out): output equal to talon's expected reply text");
const talonDir = join(dir, "fixtures/talon/tests/fixtures/standard_replies");
const parsers: [string, (t: string) => string][] = [
  ["ours, boilerplate off", ownWithBoilerplate],
  ["ours, stripReply", stripReply],
  ["email-reply-parser 2.3.9", erp],
  ["planer 1.2.0", (t) => planer.extractFromPlain(t)],
  ["talonjs 1.0.28", (t) => talon.quotations.extractFromPlain(t).body],
];
const emls = readdirSync(talonDir)
  .filter((f) => f.endsWith(".eml"))
  .sort();
const scores = parsers.map(() => 0);
for (const f of emls) {
  const text = plainPart(readFileSync(join(talonDir, f), "utf8"));
  const expectedFile = join(talonDir, f.slice(0, -4) + "_reply_text");
  const expected = existsSync(expectedFile) ? readFileSync(expectedFile, "utf8").trim() : "Hello";
  const row = parsers.map(([, fn], i) => {
    const ok = norm(fn(text)) === norm(expected);
    if (ok) scores[i]!++;
    return ok ? "ok " : "BAD";
  });
  console.log(`${f.padEnd(18)} ${row.join(" ")}`);
}
parsers.forEach(([name], i) => console.log(`${name}: ${scores[i]}/${emls.length}`));

/** The text/plain part of a MIME message (quoted-printable and base64 decoded). Enough for these fixtures. */
function plainPart(eml: string): string {
  const raw = eml.replace(/\r\n/g, "\n");
  const at = raw.search(/^Content-Type: text\/plain/im);
  const from = at < 0 ? raw : raw.slice(at);
  const split = from.indexOf("\n\n");
  const headers = from.slice(0, split);
  let part = from.slice(split + 2);
  const boundary = at < 0 ? -1 : part.search(/^--[^\n]*$/m);
  if (boundary >= 0) part = part.slice(0, boundary);
  if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(headers)) {
    part = part.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    part = new TextDecoder().decode(Uint8Array.from(part, (c) => c.charCodeAt(0)));
  } else if (/Content-Transfer-Encoding:\s*base64/i.test(headers)) {
    part = Buffer.from(part.replace(/\s+/g, ""), "base64").toString("utf8");
  }
  return part;
}
