/**
 * Correctness cross-checks (run with Bun): every tokenizer implementation yields identical hash arrays; the TS
 * murmur3 equals Rust's and `Bun.hash.murmur32v3`; and the Rust gitleaks scanner (FFI, RegexSet mode, WASM) fires
 * the same rules as the TS gate on the secret corpus. Also prints the Rust regex compile report.
 */
import { secretCorpus } from "./lib/corpus";
import { emailText, nonAsciiShare, SIZES } from "./lib/gen";
import { encode, lib, LIB_PATH, nativeReport, nativeSecretHits, nativeTokenize } from "./lib/native";
import { gitleaksHits, gitleaksOnly, secretHits } from "./lib/ts-secrets";
import { murmur3, tokenizeHash } from "./lib/tokenize";
import { loadWasm } from "./lib/wasm";

console.log(`lib: ${LIB_PATH}`);
const wasm = loadWasm();
let failures = 0;
const fail = (message: string) => {
  failures++;
  console.log(`MISMATCH ${message}`);
};

// --- Tokenizer -------------------------------------------------------------------------------------------------
const EDGES = [
  "Dana's IT'S x a1 OPS-142 we're don't _x -y 'quoted' rock'n'roll",
  "ΣΟΦΟΣ'S ΟΔΟΣ İstanbul straße ǅemal Ⅻ ² ١٢٣ 𝒜bc 𝒜 é Zoë's 東京 東 프로젝트",
  "emoji 👍🏽 ok, tab\tnew\nline — dash – end. Ünïcödé-ÄÖÜ_ß 'S's",
];
const texts: { name: string; text: string }[] = EDGES.map((text, i) => ({ name: `edge-${i}`, text }));
for (const size of SIZES) {
  texts.push({ name: `ascii-${size}`, text: emailText(size) });
  texts.push({ name: `nonascii-${size}`, text: emailText(size, true) });
}
const tsOut = new Uint32Array(8192);
const rsOut = new Uint32Array(8192);
const u16Out = new Uint32Array(8192);
const wasmOut = new Uint32Array(8192);
const bunOut = new Uint32Array(8192);
console.log("\n| text | UTF-8 bytes | non-ASCII share | tokens TS | Rust FFI | Rust FFI (UTF-16) | Rust WASM |");
console.log("|---|---:|---:|---:|---:|---:|---:|");
for (const { name, text } of texts) {
  const nTs = tokenizeHash(text, tsOut);
  const nRs = nativeTokenize(text, rsOut);
  const u16 = new Uint16Array(text.length);
  for (let i = 0; i < text.length; i++) u16[i] = text.charCodeAt(i);
  const nU16 = lib.eden_tokenize_hash_utf16(u16, u16.length, u16Out, u16Out.length);
  const nWasm = wasm.tokenize(text, wasmOut);
  const bytes = encode(text).length;
  console.log(
    `| ${name} | ${bytes} | ${(nonAsciiShare(text) * 100).toFixed(1)}% | ${nTs} | ${nRs} | ${nU16} | ${nWasm} |`,
  );
  const same = (a: Uint32Array, n: number) => n === nTs && a.subarray(0, n).every((h, i) => h === tsOut[i]);
  if (!same(rsOut, nRs)) fail(`tokenize ${name}: TS vs Rust FFI`);
  if (!same(u16Out, nU16)) fail(`tokenize ${name}: TS vs Rust FFI UTF-16`);
  if (!same(wasmOut, nWasm)) fail(`tokenize ${name}: TS vs Rust WASM`);
  const nBun = tokenizeHash(text, bunOut, (token) => Bun.hash.murmur32v3(token));
  if (!same(bunOut, nBun)) fail(`tokenize ${name}: TS vs TS + Bun.hash.murmur32v3`);
}

// --- murmur3 -----------------------------------------------------------------------------------------------------
let murmurChecked = 0;
for (const { text } of texts) {
  for (const word of text.split(/\s+/)) {
    const bytes = new TextEncoder().encode(word);
    const ts = murmur3(bytes);
    const rs = lib.eden_murmur3(bytes, bytes.length, 0);
    const bun = Bun.hash.murmur32v3(bytes, 0);
    if (ts !== rs || ts !== bun) fail(`murmur3 ${JSON.stringify(word)}: ts ${ts} rust ${rs} bun ${bun}`);
    murmurChecked++;
  }
}
console.log(`\nmurmur3: ${murmurChecked} words checked (TS = Rust = Bun.hash.murmur32v3)`);

// --- Secret scanning -------------------------------------------------------------------------------------------
interface Entry {
  kind: string;
  id: string;
  pattern: string;
  translated: boolean;
  defaultOk: boolean;
  defaultError: string | null;
  scannerOk: boolean;
  unicodeOff: boolean;
  compileUs: number;
  scannerError: string | null;
}
const report = nativeReport() as { rules: number; keywords: number; entries: Entry[] };
const count = (entries: Entry[], test: (entry: Entry) => boolean) => entries.filter(test).length;
const setBuilt = lib.eden_secrets_set_init() === 1;
console.log(`\nRust scanner: ${report.rules} rules, ${report.keywords} distinct keywords, RegexSet built: ${setBuilt}`);
const slowest = [...report.entries].sort((a, b) => b.compileUs - a.compileUs).slice(0, 6);
const totalMs = report.entries.reduce((sum, e) => sum + e.compileUs, 0) / 1000;
console.log(`\nRust regex compile time, all ${report.entries.length} regexes: ${totalMs.toFixed(1)} ms; slowest:`);
for (const e of slowest) console.log(`- ${e.kind} \`${e.id}\`: ${(e.compileUs / 1000).toFixed(1)} ms`);
console.log(
  "\n| regexes | total | compile unchanged (regex::Regex defaults) | need brace translation " +
    "| compile in scanner mode | of which Unicode off |",
);
console.log("|---|---:|---:|---:|---:|---:|");
for (const kind of ["rule", "allowlist"]) {
  const entries = report.entries.filter((entry) => entry.kind === kind);
  const cells = [
    entries.length,
    count(entries, (e) => e.defaultOk),
    count(entries, (e) => e.translated),
    count(entries, (e) => e.scannerOk),
    count(entries, (e) => e.unicodeOff),
  ];
  console.log(`| ${kind} | ${cells.join(" | ")} |`);
}
console.log("\nNot compilable unchanged with regex::Regex defaults, or translated:");
for (const entry of report.entries.filter((e) => !e.defaultOk || e.translated || !e.scannerOk)) {
  const error = entry.defaultError?.split("\n").pop()?.trim() ?? "compiles";
  const after = entry.scannerOk ? "compiles in scanner mode" : `STILL FAILS: ${entry.scannerError}`;
  console.log(`- ${entry.kind} \`${entry.id}\`: \`${entry.pattern.slice(0, 70)}\` — ${error}; ${after}`);
}

console.log(
  "\n| text | chars | TS secretHits (gitleaks rules) | Rust FFI | Rust RegexSet | Rust WASM | eden-* (TS only) |",
);
console.log("|---|---:|---|---|---|---|---|");
for (const { name, text } of secretCorpus()) {
  const full = secretHits(text);
  const ts = gitleaksOnly(full);
  const tsDirect = gitleaksHits(text);
  const rs = nativeSecretHits(text);
  const set = nativeSecretHits(text, true);
  const wa = wasm.secretHits(text);
  const show = (ids: string[]) => (ids.length ? ids.join(", ") : "—");
  const mark = (ids: string[]) => (ids.join() === ts.join() ? show(ids) : `**${show(ids)}**`);
  const eden = full.filter((id) => id.startsWith("eden-"));
  console.log(`| ${name} | ${text.length} | ${show(ts)} | ${mark(rs)} | ${mark(set)} | ${mark(wa)} | ${show(eden)} |`);
  if (tsDirect.join() !== ts.join()) fail(`secrets ${name}: gitleaksHits ${tsDirect} vs secretHits ${ts}`);
  if (rs.join() !== ts.join()) fail(`secrets ${name}: TS [${ts}] vs Rust [${rs}]`);
  if (set.join() !== ts.join()) fail(`secrets ${name}: TS [${ts}] vs Rust set [${set}]`);
  if (wa.join() !== ts.join()) fail(`secrets ${name}: TS [${ts}] vs WASM [${wa}]`);
}

console.log(`\n${failures === 0 ? "ALL CROSS-CHECKS AGREE" : `${failures} MISMATCHES`}`);
process.exit(failures === 0 ? 0 : 1);
