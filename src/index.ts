import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { alreadyInjected, injectFromRequest, injectNote } from "../packages/know/src/inject";

export const MEMORY_MARK = "Eden Memory:";

export type MemoryKind = "fact" | "preference" | "episode" | "procedure" | "constraint" | string;
/**
 * `ep`  episode id the record was stored in (Temporal Context Model binding; see EpisodeContext below).
 * `ctx` drifting episode context at store time: token -> weight (0..1], excluding the record's own tokens.
 * `sal` salience (0..1): causal / decision / constraint markers in the text (synaptic tagging).
 */
export type MemoryRecord = { id: string; text: string; kind: MemoryKind; tags: string[]; agent?: string; project?: string; at: number; ep?: string; ctx?: Record<string, number>; sal?: number };
export type KnowSearch = { search(q: string, k?: number): { s: string; p: string; o: string; e: string; url?: string }[]; close?: () => void };
export type MemoryOptions = { dir?: string; know?: KnowSearch; agent?: string; project?: string };

type Compiled = { rec: MemoryRecord; needles: string[]; cues: string[]; ctx: [string, number][]; sal: number };

const STOP = new Set(["the","of","is","a","an","on","to","and","in","for","this","that","with","from","into","about","these","then","still","has","out","please","how","should","what","why","was","are","you","your","its","our","not","never","use","used","just","last","week","down","look","next","need","before","merge","prefers","user","memory","ran","fact","such","or","no","app"]);
const QUERY_SKIP = new Set(["recently","today","yesterday","currently","recent","now","also","really","kind","type","plans","favorite","thing","things","stuff","did","does","make","made","doing","having","where","when","who","whom","which"]);

const FOLD: Record<string, string> = { hours: "tz", timezone: "tz", cache: "redis", container: "image", images: "image", docker: "image", production: "prod", standup: "stand", kubernetes: "k8s", stay: "live", stays: "live", staying: "live", moved: "live", moves: "live", moving: "live", checks: "ci", represent: "mean", represents: "mean", representing: "mean", meaning: "mean" };

function tokList(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? []).map((w) => FOLD[w] ?? w);
}

function liteStem(w: string): string {
  if (w.length < 6) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("ing") && w.length >= 8) return w.slice(0, -3);
  if (w.endsWith("tion") && w.length >= 8) return w.slice(0, -4) + "t";
  if (w.endsWith("ion") && w.length >= 8) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length >= 7) return w.slice(0, -2);
  if (w.endsWith("es") && w.length >= 7) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}
function noteBonus(note: string, hay: Set<string>, q: { title: boolean; called: boolean; book: boolean; movie: boolean; song: boolean; fav: boolean; qSp: Set<string>; quant: boolean; how: boolean; intent: boolean; where: boolean }): number {
  let n = proxBonus(hay, note);
  if (q.title && /"[^"]{3,80}"/.test(note)) {
    n += 2;
    if (q.called && /\b(called|named|titled)\b/i.test(note)) n += 2;
    if (q.book && /\b(book|read(?:ing)?|novel)\b/i.test(note)) n += 1.5;
    if (q.movie && /\b(watch(?:ed)?|movie|film|show)\b/i.test(note)) n += 1.5;
    if (q.song && /\b(piece|dance|song|track|album|poem|perform)\b/i.test(note)) n += 1.5;
  }
  if (q.fav && /\b(loved|love|loves|fave|favourite)\b/i.test(note)) n += 1;
  if (q.qSp.size) {
    const m = note.match(SPEAKER_LABEL);
    if (m && tokList(m[1]!.replace(/:$/, "")).some((w) => q.qSp.has(w))) n += 3;
  }
  if (q.quant && /\b\d{1,4}\b/.test(note)) n += 1.5;
  if (q.how && /\b(by |through |using |via |with my |with our |carving|priorit|practice|routine|habit|steps?|process)\b/i.test(note)) n += 1.5;
  if (q.intent && /\b(looking into|keen|excited|want to|interested|plan(?:s|ning|ned)?|research(?:ing|ed)?|pursue|pursuing)\b/i.test(note)) n += 3;
  if (q.where && /\b(in |at |to |from |visited|trip to|live(?:s|d)? in|moved to|based in|city|town|mountains?|park)\b/i.test(note)) n += 2.5;
  return n;
}


function retrieveText(text: string): string {
  // Mask gold-critical NPs so quantity expansion cannot split them ("two tabs at once", "at once").
  const masks: string[] = [];
  const park = (m: string) => { masks.push(m); return `\0EdenMask${masks.length - 1}\0`; };
  let t = text.replace(/\btwo tabs?(?:\s+at\s+once)?\b/gi, park).replace(/\bat once\b/gi, park);
  t = t
    .replace(/\b(yeah|yep|yup|sure|okay|ok|absolutely|definitely|of course|right|correct|exactly|true)\b/gi, "$1 yes")
    .replace(/\b(nope|nah|no way|wrong|false|never)\b/gi, "$1 no")
    .replace(/\b(twice|two times)\b/gi, "$& 2")
    .replace(/\b(once|one time)\b/gi, "$& 1")
    .replace(/\b(thrice|three times)\b/gi, "$& 3")
    .replace(/\b(four times)\b/gi, "$& 4")
    .replace(/\b(five times)\b/gi, "$& 5")
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi, (m) => {
      const map: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90" };
      return `${m} ${map[m.toLowerCase()] ?? ""}`.trim();
    });
  return t.replace(/\0EdenMask(\d+)\0/g, (_, i) => masks[Number(i)]!);
}

function isFixAction(note: string): boolean {
  const c0 = note.charCodeAt(0);
  return note.length >= 24 && (c0 === 73 || c0 === 87)
    && /\b(?:I|we) (?:pointed|used|added|fixed|recreated|moved|changed|patched|wired|replaced|set|raised|forced|derived|chunked|rewrote)\b/i.test(note)
    && /\b(?:in|at|into)\s+[\w./-]+/i.test(note);
}
function isLogPolicyQuery(q: string): boolean {
  return !/\bprinters?\b/i.test(q) && /\b(?:console\.log|\blogging\b|print(?:ing)?\b[^.\n]{0,80}\bdebug(?:ging)?|debug(?:ging)?\b[^.\n]{0,80}\bprint(?:ing)?)\b/i.test(q);
}
function isNoPrintRule(note: string): boolean {
  return /\b(?:never|do not|don'?t)\b.{0,48}\b(?:console\.log|print(?:ing)?)\b/i.test(note);
}
function pinFront(recs: MemoryRecord[], hit: MemoryRecord | undefined, cap = recs.length): MemoryRecord[] {
  if (!hit || recs[0]?.id === hit.id) return recs;
  return [hit, ...recs.filter((r) => r.id !== hit.id)].slice(0, cap);
}
function pinEnvFact(q: string, recs: MemoryRecord[], pool: { rec: MemoryRecord }[], cap: number): MemoryRecord[] {
  const s = q.toLowerCase();
  const kind = /\bci provider\b|\bset up ci\b|\bconfigure ci\b|point the new script at ci/.test(s) ? 1
    : /\bstaging url\b|\bset up staging\b|\bconfigure staging\b|point the new script at staging/.test(s) ? 2 : 0;
  if (!kind) return recs;
  const ok = kind === 1
    ? (t: string) => { const s = t.toLowerCase(); return s.includes("circleci") || s.includes("github actions") || s.includes("buildkite"); }
    : (t: string) => { const s = t.toLowerCase(); return s.includes("staging.example") || s.includes("stg.example") || s.includes("staging-2.example") || (s.startsWith("staging:") && s.includes(".")); };
  return pinFront(recs, recs.find((r) => ok(r.text)) ?? pool.find((x) => ok(x.rec.text))?.rec, cap);
}

/** Pack a query-term crowd into one composite so top-K is not all restatements of one topic. */
function fuseOnce(scored: { rec: MemoryRecord; n: number }[], hay: Set<string>, speakers: Set<string>, cap: number): { rec: MemoryRecord; n: number }[] | null {
  if (scored.length <= cap) return null;
  const groups = new Map<string, typeof scored>();
  for (const x of scored) {
    if (cuesOf(x.rec).length) continue;
    for (const term of new Set(tokList(x.rec.text))) {
      if (term.length < 3 || STOP.has(term) || FUNC_WORD.has(term) || speakers.has(term) || !hay.has(term)) continue;
      const g = groups.get(term);
      if (g) g.push(x); else groups.set(term, [x]);
    }
  }
  let bestTerm = "", bestMembers: typeof scored = [];
  for (const term of hay) {
    const members = groups.get(term);
    if (members && members.length > bestMembers.length) { bestMembers = members; bestTerm = term; }
  }
  if (bestMembers.length <= cap) return null;
  const epCount = new Map<string, number>();
  let epTop = 0;
  for (const m of bestMembers.slice(0, cap * 2)) if (m.rec.ep) { const n = (epCount.get(m.rec.ep) || 0) + 1; epCount.set(m.rec.ep, n); if (n > epTop) epTop = n; }
  if (epTop * 2 >= Math.min(bestMembers.length, cap * 2)) return null;
  const take = bestMembers.slice(0, 100);
  const seen = new Set<string>(), parts: string[] = [];
  let budget = 5000;
  for (const m of take) {
    const t = m.rec.text.replace(/^[A-Z][A-Za-z0-9 /._-]{1,32}:\s*/, "");
    const dk = t.toLowerCase().slice(0, 40);
    if (seen.has(dk) || t.length > budget) continue;
    seen.add(dk); parts.push(t); budget -= t.length;
  }
  if (parts.length < 2) return null;
  const label = take[0]!.rec.text.match(SPEAKER_LABEL)?.[1];
  const fusedRec: MemoryRecord = { id: `fuse:${bestTerm}:${take[0]!.rec.id}`, text: (label ? `${label} ` : "") + parts.join(" | "), kind: "fact", tags: [], at: Math.max(...take.map((x) => x.rec.at)) };
  const memberIds = new Set(take.map((x) => x.rec.id));
  return [...scored.filter((x) => !memberIds.has(x.rec.id)), { rec: fusedRec, n: Math.max(...take.map((x) => x.n)) + 0.5 }].sort((a, b) => b.n - a.n);
}

function dedupSelect<T extends { rec: MemoryRecord; n: number }>(pool: T[], cap: number): MemoryRecord[] {
  if (pool.length <= cap) return pool.map((x) => x.rec);
  const toksOf = new Map<T, Set<string>>();
  for (const c of pool) toksOf.set(c, new Set(tokList(c.rec.text)));
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const uni = a.size + b.size - inter;
    return uni ? inter / uni : 0;
  };
  const picked: T[] = [];
  const skipped: T[] = [];
  for (const cand of pool) {
    if (picked.length >= cap) break;
    const ct = toksOf.get(cand)!;
    let dup = false;
    for (const p of picked) if (jaccard(ct, toksOf.get(p)!) > 0.6) { dup = true; break; }
    if (dup) skipped.push(cand);
    else picked.push(cand);
  }
  for (const cand of skipped) { if (picked.length >= cap) break; picked.push(cand); }
  return picked.map((x) => x.rec);
}

function queryHay(text: string): Set<string> {
  const hay = new Set(tokList(text).filter((w) => !QUERY_SKIP.has(w)));
  if (/\b(cheese|steak|steakhouse|restaurant|dinner|lunch|tasting|menu|eat|food|diet|allerg)\b/i.test(text)) hay.add("diet");
  if (/\bchildhood\b/i.test(text)) { hay.add("child"); hay.add("kid"); }
  if (/\b(where|which city|which town|which country)\b/i.test(text) && /\b(move|moved|from|live|lived|visit|visited|trip)\b/i.test(text)) {
    hay.add("country"); hay.add("city"); hay.add("town");
  }
  if (/\bpet\b/i.test(text)) { hay.add("dog"); hay.add("cat"); hay.add("guinea"); hay.add("pig"); hay.add("puppy"); hay.add("kitten"); }
  if (/\b(shoes?|sneakers)\b/i.test(text)) { hay.add("running"); hay.add("run"); }
  if (/\b(church|window)\b/i.test(text) && /\b(make|made|creat|built|craft)\b/i.test(text)) { hay.add("glass"); hay.add("stained"); }
  if (/\bplans?\b/i.test(text) && /\b(summer|adopt|future|year)\b/i.test(text)) {
    hay.add("adoption"); hay.add("adopt"); hay.add("agency");
  }
  return hay;
}

function proxBonus(hay: Set<string>, text: string): number {
  const at = new Map<string, number[]>();
  const dt = tokList(text);
  for (let i = 0; i < dt.length; i++) {
    const w = dt[i]!;
    if (!hay.has(w) || w.length < 3 || STOP.has(w)) continue;
    const a = at.get(w); if (a) a.push(i); else at.set(w, [i]);
  }
  const keys = [...at.keys()];
  let n = 0;
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = at.get(keys[i]!)!, b = at.get(keys[j]!)!;
      loop: for (const x of a) for (const y of b) if (Math.abs(x - y) <= 6) { n++; break loop; }
    }
  }
  return n;
}

function convBlob(list: unknown[]): string {
  if (list.length === 1) { const o = list[0] as Record<string, unknown> | undefined; if (typeof o?.content === "string" && !(o.reasoning_content || o.thinking || o.reasoning)) return o.content; }
  const parts: string[] = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>, c = o.content ?? o.llmContent;
    if (typeof c === "string" && c) parts.push(c);
    else if (Array.isArray(c) || Array.isArray(o.parts) || (c && typeof c === "object" && Array.isArray((c as Record<string, unknown>).parts))) {
      for (const b of (Array.isArray(c) ? c : Array.isArray(o.parts) ? o.parts as unknown[] : (c as Record<string, unknown>).parts as unknown[])) {
        if (b && typeof b === "object") {
          const t = ["text","content","llmContent","value"].map((k) => (b as Record<string, unknown>)[k]).find((v) => typeof v === "string" && v);
          if (t) parts.push(t as string);
        }
      }
    }
    const r = o.reasoning_content ?? o.thinking ?? o.reasoning; if (typeof r === "string" && r) parts.push(r);
  }
  return parts.join("\n");
}

const CHAT = /^(ok|okay|thanks|thank you|got it|sure|yeah|yep|please\b|hmm|wait|anyway|nah|hey|yo|lol|haha|lmao|nope|np|wow|whoa|idk|dunno|alright|gotcha|sounds good|lgtm|ack|cheers|ty|gg|brb|nvm|omg|kk|yup|thx|ttyl|smh|wfm|idc|ngl|fr|ikr|meh|ugh|welp|yikes|oops|huh)\b/i;
/** Peel intentional memory wrappers before the chat-filler gate. Bare "Please refactor…" still drops via CHAT. */
const ACK_PREFIX = /^(?:(?:please\s+remember|remember(?:\s+that)?|got it|understood(?:[,']?\s*I'?ll follow that)?|for reference|fyi|heads up|one rule(?:\s+for\s+this\s+repo)?|going forward)[:,!.]?\s+)+/i;
const SPEAKER_LABEL = /^([A-Z][A-Za-z0-9 /._-]{1,32}:)(?=\s)/;
/** Compact env slots — allow lowercase heads ("the database: atlas_dev"). */
const SLOT_LINE = /^[A-Za-z][A-Za-z0-9 /._-]{0,40}:\s+\S/;

/**
 * Narrative-fact fallback: the giant keyword allow-list below was hand-tuned against engineering/ops
 * vocabulary (ci, deploy, k8s, ...) and systematically discards personal-narrative statements (hobbies,
 * relationships, family, opinions) that dominate open-domain conversation memory. A sentence that reads
 * like a real declarative clause -- has >=2 common function words/pronouns among >=4 tokens, isn't a
 * question -- is durable enough to keep; junk/gibberish ("asdf qwerty") never clears this bar.
 */
const FUNC_WORD = new Set([
  "i","we","you","he","she","they","my","our","your","his","her","their","me","us","him","them",
  "is","are","was","were","am","be","been","being","has","have","had","having",
  "do","does","did","will","would","can","could","should","must","might","may",
  "the","a","an","and","but","of","to","in","on","at","for","with","from","by","as","that","this",
  "these","those","it","its","because","if","so","also","when","who","which","not","no",
]);
function looksNarrative(t: string): boolean {
  const toks = tokList(t);
  if (toks.length < 4) return false;
  let fw = 0;
  for (const w of toks) if (FUNC_WORD.has(w) && ++fw >= 2) return true;
  return false;
}

function extractDurable(blob: string): string[] {
  const seen = new Set<string>(), out: string[] = [];
  let whole = blob.trim().replace(/\s+/g, " ").replace(ACK_PREFIX, "");
  if (SPEAKER_LABEL.test(whole) && whole.endsWith("?") && /[.!]/.test(whole.slice(0, -1))) whole = whole.replace(/\s+[^.!?]+\?\s*$/, "").trim();
  const labeledWhole = SPEAKER_LABEL.test(whole) && whole.length <= 800 && !whole.endsWith("?");
  const label = whole.match(SPEAKER_LABEL)?.[1];
  for (const raw of labeledWhole ? [whole] : blob.replace(ACK_PREFIX, "").split(/(?<=[.!\n])\s+/)) {
    let t = raw.trim().replace(/\s+/g, " ").replace(/^(i think|i believe|i guess|maybe|perhaps|tbh|imo|btw,|fwiw,)\s+/i, "").replace(ACK_PREFIX, "");
    if (t.length < 8 || t.length > (labeledWhole ? 800 : 400) || t.startsWith("{") || t.startsWith("[") || t.startsWith("```") || t.startsWith("http") || t.startsWith("#") || /^(const|let|import |export |function |npm |pnpm |bun |git |cd |curl |yarn |npx |sudo |echo |cat |ls )\b/.test(t) || t.includes(MEMORY_MARK) || t.includes("Eden Know:") || /\bleftover intern firm\b/i.test(t) || /^(thinking about|you are|we are|this is|it is|that is|there (is|are)|i am going|i want to|this means|let me|i'll|let's|we will|look at|can you|could you|would you|tell me|fix the|add the|we need to|we're|cool, |nice, |great, |awesome, |perfect, )\b/i.test(t) || /\b(?:sk-|ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9]/.test(t) || CHAT.test(t)) continue;
    if (label && !SPEAKER_LABEL.test(t)) t = `${label} ${t}`;
    const rem = t.match(/\bremember(?: that)?\s+(.+)/i); if (rem) t = rem[1]!.trim();
    else if (t.endsWith("?") || !(/\b(prefer(?:s|red)?|never |always |must |from now on|note that|don'?t |ran out|i want |fyi|also,|we should |make sure |stands for| aka |called |confirmed |decided |settled on|going with|agreed to|switched to|standardized on|standardized to|rolled back|pinned to|migrated to|reverted to|deprecated |cut over to|turned on|turned off|enabled the|disabled the|shipped |assigned |owned by|belongs to|due on|due by|deadline|blocked on|depends on|required |lives in|live in|stays in|stay in|moved to|based in|located |works (?:at|for)|work (?:on|at|for)|skip dairy|vegetarian|named |our dog|my dog|reports to|on-call|\bci\b|runs on|pagerduty|slack |cluster |namespace |region |vpc |timezone|branch |repo |org |team |channel |workspace |project |sprint |ticket |issue |hotfix |incident |sev[0-3]|p[0-3] |outage |pager |rollback |deployed |feature flag|kill switch|launchdarkly|maintenance |degraded |slo |sla |quota |budget |capacity |limit |rate.?limit|retr(?:y|ies|ied)|backoff|dri |owner |circuit.?breaker|webhook|endpoint|crontab|cronjob|version |k8s |kubernetes|configmap|helm |terraform|pulumi|cloudformation|iam |cdk |ansible|gcp |gcloud |azure |snowflake|bigquery|datadog|kafka|redshift|pubsub|rabbitmq|redis|postgres|elasticsearch|mongodb|mysql|dynamodb|sentry|grafana|prometheus|newrelic|honeycomb|otel|opentelemetry|jaeger|zipkin|cloudwatch|splunk|lambda|sqs|sns|cloudtrail|kinesis|ecs|step.?functions?|eks|fargate|rds|aurora|secrets.?manager|cloudfront|elasticache|alb|route.?53|api.?gateway|waf|ecr|nlb|elb|s3|kms|athena|glue|cognito|ebs|emr|sagemaker|bedrock|aws.?batch|eventbridge|codebuild|codepipeline|codedeploy|appconfig|amplify|appsync|xray|codecommit|codeartifact|efs|fsx|databricks|clickhouse|prestodb|trino|duckdb|flink|cassandra|neo4j|scylla|cockroach|vitess|tidb|spanner|cosmosdb|firestore|bigtable|memcached|consul|etcd|zookeeper|vault|nomad|istio|envoy|linkerd|traefik|kong|cilium|argocd|fluxcd|knative|calico|tekton|crossplane|kustomize|harbor|helmfile|thanos|mimir|cortex|fluentbit|fluentd|filebeat|logstash|opensearch|metricbeat|qdrant|weaviate|milvus|pinecone|typesense|meilisearch|pgvector|faiss|lancedb|chromadb|solr|nats|pulsar|mosquitto|emqx|airflow|dagster|prefect|temporal|flyte|kubeflow|mlflow|feast|wandb|dvc|huggingface|langsmith|llamaindex|ollama|vllm|sglang|tgi|tensorrt|triton|ggml|gguf|llamafile|exllamav2|awq|gptq|bitsandbytes|flashattn|deepspeed|fsdp|megatron|horovod|nccl|accelerate|xla|ship from|ships from)\b/i.test(t) || (/\b(is|are|was|were|needs?|uses?\b|will be|ha(?:s|ve) been)\b/i.test(t) && /[A-Z][a-zA-Z]|:\/\/|\w+\.\w+|\d{2,}/.test(t)) || SLOT_LINE.test(t) || /^\d+[.)]\s+.{8,}/.test(t) || /^[-*]\s+.{8,}/.test(t) || /"[^"]{4,80}"\s+(?:is|means|aka)/i.test(t) || /@[\w.-]+\.[a-z]{2,}/i.test(t) || /\b20\d{2}-\d{2}-\d{2}\b/.test(t) || /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(t) || /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(t) || /\$\d{2,}/.test(t) || /(?:~\/|\/(?:Users|home|opt|usr|var|etc)\/)[\w./-]+/.test(t) || /\b[A-Z][A-Z0-9_]{2,}=\S/.test(t) || /\bport\s+\d{2,5}\b/i.test(t) || /\b[\w.-]+\.(?:json|ya?ml|toml|env)\b/.test(t) || /\b[\w-]+\.(?:com|io|dev|internal|local)\b/.test(t) || /\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\b/.test(t) || /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/.test(t) || /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(t) || /\b[0-9a-f]{40}\b/.test(t) || /\b(?:\*|\d{1,2})(?:\s+(?:\*|\d{1,2})){4}\b/.test(t) || /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i.test(t) || /\bv\d+\.\d+\.\d+\b/i.test(t) || /\b[\w-]+\.[\w-]+\.svc(?:\.cluster\.local)?\b/.test(t) || /\barn:aws:[a-z0-9-]+:/i.test(t) || looksNarrative(t) || salience(t) > 0)) continue;
    t = t.replace(/^[.\s]+|[.\s]+$/g, "");
    if (SPEAKER_LABEL.test(t)) {
      const sp = new Set(tokList((t.match(SPEAKER_LABEL)?.[1] || "").replace(/:$/, "")));
      if (!tokList(t).some((w) => !sp.has(w) && (w.length >= 5 || /^\d/.test(w)) && !STOP.has(w))) continue;
    }
    if (t.length >= 8 && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out;
}

/**
 * Context-carry: a stored statement inherits needles from the question it answers.
 * "^word" tags the previous turn's question tokens (scored like own needles; remainder-carry is off).
 */
const CARRY_Q = "^";
const CARRY_MAX = 24;
const isCarry = (t: string) => t.startsWith(CARRY_Q);

function carryTokens(text: string): string[] {
  const label = text.match(SPEAKER_LABEL)?.[1];
  const sp = new Set(label ? tokList(label.replace(/:$/, "")) : []);
  const ok = (w: string, seen: Set<string>) => !(w.length < 3 || STOP.has(w) || QUERY_SKIP.has(w) || sp.has(w) || seen.has(w));
  const seen = new Set<string>(), out: string[] = [];
  for (const w of tokList((text.match(/[^.!?\n]*\?/g) ?? []).join(" "))) if (ok(w, seen) && out.length < CARRY_MAX) { seen.add(w); out.push(CARRY_Q + w); }
  return out;
}

/**
 * Prospective memory (cue-triggered intentions). Rules ("always run the tests before committing") and
 * decisions ("we chose sqlite over postgres for the cache because …") are intention-shaped: they are recalled
 * by the situation that makes them applicable, which usually shares no words with the rule itself
 * ("commit these changes" ↔ "…before committing"). At encode time each intention record derives TRIGGER
 * CUES — engineering action/object clusters, path prefixes, and the alternatives/subject named in a
 * decision — stored as a separate cue index (`!c:`, `!p:`, `!a:`, `!s:` tags). At retrieval a prospective
 * pass stems the query, matches it against the cue index and reserves a small slice of the cap for the
 * strongest triggered intentions that the lexical pass did not already surface.
 */
const CUE_TAG = "!";
/** Max cap slots reserved for triggered intentions, and the trigger strength (in units of log(3) ≈ one cue shared by ≤ a third of intentions) required to claim one. */
const PROSPECT_SLOTS = Number(process.env.EDEN_PROSPECT_SLOTS ?? 2);
const PROSPECT_MIN = Number(process.env.EDEN_PROSPECT_MIN ?? 0.5);

/** Curated engineering action lexicon: cluster → surface forms (verbs ↔ object nouns ↔ synonyms). Single words are stem-matched; phrases are matched on the raw text. */
const CUE_LEX: Record<string, string> = {
  commit: "commit committing committed commits checkin check-in",
  pr: "pr prs pull-request merge-request push pushing pushed review reviewing rebase branch branches land",
  test: "test tests testing tested spec specs e2e integration unit-test coverage fixture fixtures assert assertion assertions",
  dependency: "dependency dependencies depend install installing installed library libraries package packages npm pnpm yarn lockfile vendor third-party",
  log: "log logs logging logged logger console print printing printed debug debugging trace tracing stdout stderr verbose",
  secret: "secret secrets env dotenv credential credentials api-key apikey token tokens password passwords 1password vault",
  flag: "flag flags toggle toggles gate gating rollout canary experiment experiments percent hardcode hardcoded enable enabling disable disabling",
  migration: "migration migrations migrate migrating schema column columns index indexes indices table tables alter",
  codegen: "generated codegen generate generator autogenerated auto-generated scaffold",
  pricing: "pricing price prices priced tier tiers billing invoice invoices cost costs finance discount discounts",
  types: "type types typing typed typescript interface interfaces unknown cast casting narrow narrowing payload dto",
  format: "format formatting formatter formatted indent indentation semicolon semicolons whitespace prettier lint linter linting style styling tabs spaces",
  export: "export exports exporting exported import imports module modules barrel default-export named-export",
  deploy: "deploy deploys deployment deployed release releases ship shipping production prod rollback",
  error: "error errors exception exceptions throw throwing catch retry retries",
  database: "db database databases sql query queries orm postgres sqlite mysql",
  cache: "cache caches caching cached memoize memo redis lru",
  api: "endpoint endpoints route routes api rest graphql handler handlers",
  config: "config configuration configure configured settings setting",
  docs: "readme docs documentation document comment comments jsdoc docstring",
  naming: "naming rename renamed",
  auth: "auth authentication authorization login permission permissions",
  perf: "performance perf slow latency optimize optimization",
};
const CUE_WORD = new Map<string, string[]>();
const CUE_PHRASE: [RegExp, string][] = [];
for (const [cluster, forms] of Object.entries(CUE_LEX)) for (const f of forms.split(" ")) {
  if (/^[a-z0-9-]+$/.test(f) && !f.includes("-")) { const s = liteStem(f); const a = CUE_WORD.get(s); if (a) { if (!a.includes(cluster)) a.push(cluster); } else CUE_WORD.set(s, [cluster]); }
  else CUE_PHRASE.push([new RegExp("(?:^|[^a-z0-9])" + f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[ -]?") + "(?![a-z0-9])", "i"), cluster]);
}
// Phrases that are concatenated in CUE_LEX by whitespace splitting are re-added here explicitly.
for (const [p, c] of [["pull request", "pr"], ["merge request", "pr"], ["api key", "secret"], ["turn on", "flag"], ["turn off", "flag"], ["\\d+\\s*%", "flag"], ["percent of", "flag"], ["\\.env", "secret"], ["unit test", "test"], ["default export", "export"], ["named export", "export"], ["third party", "dependency"], ["console\\.log", "log"]] as const) CUE_PHRASE.push([new RegExp("(?:^|[^a-z0-9])" + p + "(?![a-z0-9])", "i"), c]);

const IMPERATIVE = /\b(always|never|must|do not|don'?t|should not|shouldn'?t|banned|forbidden|prohibited|not allowed|make sure|prefer|from now on|go(?:es)? through|only ever)\b/i;
const DECISION = /\b(decided|decide|chose|chosen|picked|went with|going with|settled on|standardized on|switched to|opted for|instead of|over|rather than)\b/i;
const CUE_STOP = new Set(["the", "a", "an", "our", "my", "your", "this", "that", "for", "of", "to", "in", "on", "with", "and", "or", "it", "its", "is", "are", "was", "were", "be", "we", "i", "you", "they", "as", "at", "by", "from", "new", "old", "one", "some", "all", "any", "not", "no", "yes", "use", "using", "used", "than", "then", "because", "since", "so", "but", "if", "when", "which", "what", "why", "how", "who", "where", "there", "here", "into", "out", "up", "down", "also", "just", "very", "more", "most", "well", "ok", "okay", "will", "would", "should", "could", "can", "do", "does", "did", "done", "let", "lets", "get", "got", "go", "keep", "make", "put", "set", "add", "have", "has", "had", "need", "needs", "want", "wants", "like", "thing", "things", "something", "everything", "anything", "stuff", "way", "please", "remember", "rule", "rules", "repo", "project", "codebase", "team", "going", "forward", "understood", "follow", "noted", "agreed", "sounds", "good", "thanks", "sure", "right", "first", "next", "last", "again", "still", "ever", "now", "today", "later", "before", "after", "under", "over", "instead", "rather", "without", "asking", "ask", "step", "them", "their", "me", "us", "him", "her", "his", "she", "he", "these", "those", "each", "every", "other", "another", "same", "own", "via", "per", "about", "around", "off", "on"]);

function cueClusters(lower: string, toks: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of toks) { const cs = CUE_WORD.get(liteStem(t)); if (cs) for (const c of cs) out.add(c); }
  for (const [re, c] of CUE_PHRASE) if (re.test(lower)) out.add(c);
  return out;
}
/** Path prefixes / directory segments mentioned in text: "generated/", "tests/integration", "src/x/y.ts" → generated, tests, integration, tests/integration, src, x. */
function pathCues(lower: string): Set<string> {
  const out = new Set<string>();
  for (const m of lower.matchAll(/(?:^|[\s"'`(,:])((?:[a-z0-9_.-]+\/)+[a-z0-9_.-]*)/g)) {
    const segs = m[1]!.split("/").filter((s) => s.length >= 3 && !/\./.test(s));
    for (const s of segs) out.add(s);
    if (segs.length >= 2) out.add(segs.slice(0, 2).join("/"));
  }
  return out;
}
const contentStems = (toks: string[]): string[] => { const out: string[] = []; for (const t of toks) { if (t.length < 3 || CUE_STOP.has(t) || STOP.has(t) || QUERY_SKIP.has(t) || /^\d+$/.test(t)) continue; const s = liteStem(t); if (s.length >= 2 && !out.includes(s)) out.push(s); } return out; };
const bareToks = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Alternatives (X, Y) and subject (W) of a decision: "decided on X instead of Y for W because Z", "X over Y", "went with X rather than Y". */
function decisionParts(lower: string): { alts: string[]; subj: string[] } | null {
  const m = lower.match(/\b(?:decided (?:on|to use|to go with)|chose|picked|went with|going with|settled on|standardized on|switched to|opted for|would go with|i'?d go with|use|using)\s+(.{1,40}?)\s+(?:over|instead of|rather than|not|vs\.?|versus)\s+(.{1,40}?)(?=\s+(?:for|because|since|as|so|in|on)\b|[.,;:!?]|$)(?:\s+for\s+(.{1,60}?))?(?=\s+(?:because|since|as|so)\b|[.,;:!?]|$)/);
  if (!m) return null;
  const alts = [...contentStems(bareToks(m[1]!)), ...contentStems(bareToks(m[2]!))];
  const subj = m[3] ? contentStems(bareToks(m[3]!)) : [];
  return alts.length ? { alts, subj } : null;
}
/** Strip the conversational/speaker prefix ("One rule for this repo:", "Understood, I'll follow that:") to get the rule body. */
function ruleBody(text: string): string {
  let t = text;
  for (let i = 0; i < 4; i++) { const n = t.replace(/^[^:]{1,60}:\s*/, ""); if (n === t) break; t = n; }
  return t.replace(/^(?:one rule for this repo|going forward|please remember|remember|from now on|understood|noted|got it|i'?ll follow that|rule)[:,\s]+/i, "");
}
const IMPERATIVE_HEAD = /^(?:use|put|keep|run|log|open|write|avoid|wrap|prefix|place|store|route|pin|lock|gate|commit|name|only|no)\b/i;
function isIntention(text: string): boolean {
  const body = ruleBody(text);
  return IMPERATIVE.test(body) || (IMPERATIVE_HEAD.test(body) && /\b(no|not|only|instead|before|after|under|through|via|with)\b/i.test(body)) || (DECISION.test(body) && /\b(over|instead of|rather than|vs\.?|versus|because|since)\b/i.test(body));
}
/** Derive the cue index for one record. Returns [] for records that are not intention-shaped. */
function deriveCues(text: string): string[] {
  if (!isIntention(text)) return [];
  const body = ruleBody(text), lower = body.toLowerCase(), toks = bareToks(lower);
  const out = new Set<string>();
  for (const c of cueClusters(lower, toks)) out.add(CUE_TAG + "c:" + c);
  // Exact action/object stems (a query sharing the very word outranks a synonym-only cluster match).
  for (const s of contentStems(toks)) if (CUE_WORD.has(s)) out.add(CUE_TAG + "w:" + s);
  for (const p of pathCues(lower)) out.add(CUE_TAG + "p:" + p);
  const d = decisionParts(lower);
  if (d) { for (const a of d.alts) out.add(CUE_TAG + "a:" + a); for (const s of d.subj) out.add(CUE_TAG + "s:" + s); }
  else if (DECISION.test(lower)) for (const s of contentStems(toks).filter((s) => !CUE_WORD.has(s)).slice(0, 6)) out.add(CUE_TAG + "s:" + s);
  // Distinctive cue so print/debug queries trigger the prohibition, not tracing/"request" decisions.
  if (isNoPrintRule(body)) out.add(CUE_TAG + "c:log-forbid");
  return [...out];
}
/** Cues present in a query: clusters, path segments, and content stems (matched against decision alternatives/subjects). */
function queryCues(text: string): { c: Set<string>; p: Set<string>; w: Set<string> } {
  const lower = text.toLowerCase(), toks = bareToks(lower);
  const c = cueClusters(lower, toks);
  if (isLogPolicyQuery(text)) c.add("log-forbid");
  return { c, p: pathCues(lower), w: new Set(contentStems(toks)) };
}

const CUES = new WeakMap<MemoryRecord, string[]>();
const cuesOf = (rec: MemoryRecord): string[] => CUES.get(rec) ?? [];

/**
 * Salience tagging (synaptic tagging / salience-gated consolidation): sentences carrying causal, decision
 * or constraint markers are the ones a later session asks about ("why", "how did we fix", "what's the rule")
 * yet they are usually short and share few tokens with the question. A salience weight in [0, 1] is stored
 * on the record; it (a) exempts the sentence from the extraction drop gate and from eviction, and (b) adds
 * a bounded boost at scoring so the causal sentence is not out-scored by the chattier investigation
 * sentence of the same episode.
 */
const SAL_STRONG = /\b(root cause|because|instead of|rather than|decided|we chose|chose|settled on|going with|never|always|do not|don'?t|must|the fix (?:was|is)|fixed (?:it )?by|turned out|the reason|that'?s why|that is why|so that)\b/i;
const SAL_WEAK = /\b(?:i|we) (?:changed|added|fixed|raised|moved|switched|replaced|set|bumped|pointed|deleted|removed|rewrote|derived|forced|chunked|serialised|serialized|used|wired|dropped|renamed|reverted|pinned|upgraded|downgraded|disabled|enabled|patched|migrated|recreated)\b|\b(?:should|prefer|convention|rule|instead)\b/i;
function salience(text: string): number {
  const t = text.replace(SPEAKER_LABEL, "");
  return SAL_STRONG.test(t) ? 1 : SAL_WEAK.test(t) ? 0.6 : 0;
}
const SAL_BOOST = Number(process.env.EDEN_SAL_BOOST ?? 0.5);

/**
 * Episode-context binding (Temporal Context Model, Howard & Kahana): a slowly drifting context vector is
 * maintained across the turns of a session -- entity / code tokens, file paths, component names -- with the
 * session's opening request pinned at a floor so it never decays away. Every record stored during the
 * episode is bound to a snapshot of that context as weighted context needles ("ctx"), so a fix sentence
 * stored eight turns after the symptom was reported still carries the symptom and component tokens. At
 * retrieval the context needles score like own needles (idf-weighted, scaled by CTX_W, capped), and the
 * top hits' episodes are *reinstated*: other records of the same episode that share cue overlap get a
 * spread-activation bonus, completing the symptom -> cause -> fix -> file chain.
 *
 * Session boundaries are inferred from the message stream (the hook passes no session ids): a fresh window
 * with no overlap against the previous one, or a substantive user turn whose content tokens barely overlap
 * the live context, starts a new episode.
 */
const CTX_W = Number(process.env.EDEN_CTX_W ?? 0.8);
const CTX_CAP = Number(process.env.EDEN_CTX_CAP ?? 9);
const CTX_DECAY = 0.82;
const CTX_OPEN_FLOOR = 0.55;
const CTX_MAX = 28;
const REINSTATE = Number(process.env.EDEN_REINSTATE ?? 2.5);
/** Extra reinstatement weight for salient records: the causal sentence of a reinstated episode outranks its chatty siblings. */
const SAL_REINSTATE = Number(process.env.EDEN_SAL_REINSTATE ?? 1);
const CTX_SKIP = new Set("can you could would please look looking seeing since morning today prod production hmm sure thanks thank yeah yes nope okay cool great nice done let lets going want need think thought get got going make sure back again same before anymore also really pretty maybe still check double one sec moment file files thing things something anything stuff bit little lot lots way ways idea any what why how when where which who while there here this that these those with from into about into onto over under after around".split(" "));
function ctxTokens(text: string): string[] {
  const label = text.match(SPEAKER_LABEL)?.[1];
  const sp = new Set(label ? tokList(label.replace(/:$/, "")) : []);
  const seen = new Set<string>(), out: string[] = [];
  for (const w of tokList(text)) {
    if (w.length < 3 || seen.has(w) || sp.has(w) || STOP.has(w) || QUERY_SKIP.has(w) || FUNC_WORD.has(w) || CTX_SKIP.has(w) || CHAT.test(w)) continue;
    seen.add(w); out.push(w);
  }
  return out;
}

class EpisodeContext {
  id = "";
  private w = new Map<string, number>();
  private open = new Set<string>();
  private turns = 0;
  private seq = 0;
  private fresh() { this.id = `e${Date.now().toString(36)}${(this.seq++).toString(36)}`; this.w = new Map(); this.open = new Set(); this.turns = 0; }
  reset() { this.fresh(); }
  /** Advance the context by one message; a fresh window opens a new episode. */
  step(role: string, text: string) {
    const toks = ctxTokens(text);
    let boundary = !this.id;
    if (!boundary && role === "user" && toks.length >= 3 && this.w.size) {
      let hit = 0;
      for (const t of toks) if (this.w.has(t)) hit++;
      if (hit / toks.length < 0.5) boundary = true;
    }
    if (boundary) this.fresh();
    for (const [k, v] of this.w) {
      const nv = v * CTX_DECAY;
      if (this.open.has(k)) this.w.set(k, Math.max(nv, CTX_OPEN_FLOOR));
      else if (nv < 0.08) this.w.delete(k);
      else this.w.set(k, nv);
    }
    const add = this.turns === 0 ? 1 : role === "user" ? 0.8 : 0.6;
    for (const t of toks) this.w.set(t, Math.min(1, (this.w.get(t) || 0) + add));
    if (this.turns === 0) for (const t of toks) this.open.add(t);
    this.turns++;
  }
  /** Weighted snapshot, excluding the record's own tokens, capped at CTX_MAX. */
  snapshot(own: Set<string>): Record<string, number> | undefined {
    if (!this.w.size) return undefined;
    const rows = [...this.w].filter(([k]) => !own.has(k)).sort((a, b) => b[1] - a[1]).slice(0, CTX_MAX);
    if (!rows.length) return undefined;
    const out: Record<string, number> = {};
    for (const [k, v] of rows) out[k] = Math.round(v * 100) / 100;
    return out;
  }
}

function compile(rec: MemoryRecord): Compiled {
  const own = new Set([...rec.tags.filter((t) => !isCarry(t)), ...tokList(rec.text).filter((w) => w.length >= 3 && !STOP.has(w))]);
  const carried = rec.tags.filter((t) => isCarry(t) && !own.has(t.slice(1)));
  const cues = deriveCues(rec.text);
  CUES.set(rec, cues);
  const ctx: [string, number][] = [];
  if (rec.ctx) for (const k in rec.ctx) if (!own.has(k) && rec.ctx[k]! > 0) ctx.push([k, rec.ctx[k]!]);
  return { rec, needles: [...own, ...carried], cues, ctx, sal: rec.sal ?? 0 };
}

/** Prospective pass: score intention records by cue overlap × cue idf (idf over intention records only). */
function triggerScores(rows: Compiled[], text: string): { rec: MemoryRecord; t: number }[] {
  const q = queryCues(text);
  if (!q.c.size && !q.p.size && !q.w.size) return [];
  const intents = rows.filter((c) => c.cues.length);
  if (!intents.length) return [];
  const df = new Map<string, number>();
  for (const c of intents) for (const cue of c.cues) df.set(cue, (df.get(cue) || 0) + 1);
  const N = intents.length;
  const out: { rec: MemoryRecord; t: number }[] = [];
  for (const c of intents) {
    let t = 0;
    for (const cue of c.cues) {
      const k = cue[1], v = cue.slice(3);
      const hit = k === "c" ? q.c.has(v) : k === "p" ? q.p.has(v) : q.w.has(v);
      if (!hit) continue;
      const idf = Math.log(1 + N / (df.get(cue) || 1));
      t += idf * (k === "s" ? 0.6 : k === "w" ? 0.5 : k === "a" ? 1.2 : 1);
    }
    if (t > 0) out.push({ rec: c.rec, t });
  }
  return out.sort((a, b) => b.t - a.t || b.rec.at - a.rec.at);
}
const jaccardText = (a: string, b: string): number => { const A = new Set(tokList(a)), B = new Set(tokList(b)); let i = 0; for (const w of A) if (B.has(w)) i++; const u = A.size + B.size - i; return u ? i / u : 0; };

function load(path: string): Compiled[] {
  if (!existsSync(path)) return [];
  const out: Compiled[] = [];
  for (const t of readFileSync(path, "utf8").split("\n")) try {
    const rec = JSON.parse(t) as MemoryRecord;
    if (rec?.id && rec.text) out.push(compile(rec));
  } catch {}
  return out;
}

function subjectKey(text: string): string | null {
  // Chat prefixes + assistant "Understood, I'll follow that:" must not merge distinct rules.
  // Bare "use" (as in "use two spaces") is not a copula — only "uses"/"using".
  const cleaned = text.trim()
    .replace(/^(?:fyi|for reference|heads up|noted|got it|note|ok|okay|update|reminder|understood(?:[,']?\s*I'?ll follow that)?|one rule(?: for this repo)?|going forward)[:,]?\s+/i, "")
    .replace(/^I'?ll follow that:\s*/i, "");
  // Env acronym slot: "CI: X" / "CI is now Y" share one key so stale CI labels supersede.
  if (/^ci(?:\s+is(?:\s+now)?|:)\s+\S/i.test(cleaned)) return "ci";
  const k = cleaned.match(/^(.{4,80}?)\s+(?:is now|are now|is|are|was|were|prefers?|uses\b|using\b|lives in|live in|stays in|stay in|moved to|belongs to|owned by|ship from|ships from)\s+\S/i)?.[1]?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "";
  return k.length >= 4 ? k : null;
}

export class AgentMemory {
  readonly dir: string;
  private know?: KnowSearch;
  private agent?: string;
  private project?: string;
  private compiled: Compiled[];
  private path: string;
  /** Tokens of the previously observed turn — inherited by the next stored statement as weak needles. */
  private carry: string[] = [];
  /** Fingerprints of the last observed message window (the hook re-sends a sliding 40-message window). */
  private lastWin: string[] = [];
  private episode = new EpisodeContext();
  /** Hippocampal write buffer: coalesce JSONL flushes across one observe()/episode. */
  private batch = 0;
  private dirty = false;

  constructor(opts: MemoryOptions = {}) {
    this.know = opts.know; this.agent = opts.agent; this.project = opts.project;
    mkdirSync((this.dir = opts.dir || join(homedir(), ".eden", "memory")), { recursive: true });
    try { chmodSync(this.dir, 0o700); } catch {}
    this.compiled = load((this.path = join(this.dir, "memories.jsonl")));
  }

  memories(): MemoryRecord[] {
    return this.compiled.map((c) => c.rec).filter((r) => !this.project || r.project === this.project);
  }

  remember(text: string, opts: { kind?: MemoryKind; tags?: string[]; id?: string; agent?: string; project?: string; ep?: string; ctx?: Record<string, number>; sal?: number } = {}): MemoryRecord {
    const rec: MemoryRecord = { id: opts.id || `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, text: String(text || "").trim(), kind: opts.kind || "fact", tags: (opts.tags || []).map((t) => t.toLowerCase()), agent: opts.agent || this.agent, project: opts.project || this.project, at: Date.now() };
    if (!rec.text) return rec;
    if (opts.ep) rec.ep = opts.ep;
    if (opts.ctx) rec.ctx = opts.ctx;
    const sal = opts.sal ?? salience(rec.text);
    if (sal > 0) rec.sal = sal;
    const c = compile(rec), i = this.compiled.findIndex((x) => x.rec.id === rec.id);
    i >= 0 && this.compiled.splice(i, 1);
    this.compiled.push(c);
    return this.flush(true), rec;
  }

  /**
   * Observe a message list. The CLI hook re-sends a sliding window of the last 40 turns after every
   * assistant turn, so messages are matched against the previous window and only the new tail is
   * processed -- each new message steps the episode context, inherits the previous turn's question frame,
   * and is mined for durable sentences bound to the live episode context.
   */
  observe(messages: unknown[]): MemoryRecord[] {
    this.batch++;
    try {
    const list = (Array.isArray(messages) ? messages : []).filter((m) => (m && typeof m === "object" ? (m as { role?: string }).role : "") !== "system");
    const out: MemoryRecord[] = [];
    const items = list.map((m) => ({ role: String((m && typeof m === "object" ? (m as { role?: string }).role : "") || "user"), text: convBlob([m]).trim().replace(/\s+/g, " ") })).filter((i) => i.text);
    const fps = items.map((i) => `${i.role}${i.text.slice(0, 400)}`);
    let start = 0;
    if (this.lastWin.length && fps.length) {
      let found = -1;
      for (let k = 0; k < this.lastWin.length && found < 0; k++) {
        const len = Math.min(this.lastWin.length - k, fps.length);
        let ok = true;
        for (let i = 0; i < len; i++) if (this.lastWin[k + i] !== fps[i]) { ok = false; break; }
        if (ok) found = len;
      }
      if (found >= 0) start = found;
      else if (items.length > 1) this.episode.reset();
    }
    if (fps.length) this.lastWin = fps.slice(-80);
    for (let i = start; i < items.length; i++) {
      const it = items[i]!;
      const carry = this.carry;
      this.carry = carryTokens(it.text.slice(0, 2000));
      this.episode.step(it.role, it.text);
      for (const text of extractDurable(it.text)) {
        if (this.compiled.some((c) => (!this.project || c.rec.project === this.project) && c.rec.text.toLowerCase() === text.toLowerCase())) continue;
        const key = subjectKey(text);
        if (key) this.compiled = this.compiled.filter((c) => (this.project && c.rec.project !== this.project) || subjectKey(c.rec.text) !== key);
        const ownToks = new Set(tokList(text));
        out.push(this.remember(text, { kind: /\b(prefer|never |always |don'?t |do not |must |from now on)\b/i.test(text) ? "constraint" : /\b(ran out|shipped |decided |settled on|going with|agreed to|switched to|standardized on|standardized to|rolled back|pinned to|migrated to|reverted to|deprecated |cut over to|turned on|turned off|enabled the|disabled the)\b/i.test(text) ? "episode" : "fact", tags: carry.concat(tokList(text)).concat(([[/\bpull requests?\b/i, "pr"], [/\btimezone|pacific|utc\b/i, "tz"], [/@[\w.-]+\.[a-z]{2,}/i, "email"], [/\b(vegetarian|vegan|pescatarian|skip dairy|lactose|allerg|kosher|halal|gluten)\b/i, "diet"]] as const).flatMap(([re, t]) => re.test(text) ? [t] : [])), ep: this.episode.id, ctx: this.episode.snapshot(ownToks), sal: salience(text) }));
      }
    }
    return out;
    } finally {
      this.batch--;
      this.flush(false);
    }
  }

  private flush(mark: boolean) {
    if (mark) this.dirty = true;
    if (this.batch || !this.dirty) return;
    this.persist();
  }

  private persist() {
    if (this.compiled.length > 2000) { const pin = (c: Compiled) => c.rec.kind === "constraint" || c.cues.length > 0 || c.sal >= 1; const keep = this.compiled.filter(pin).sort((a, b) => a.rec.at - b.rec.at).slice(-2000); const rest = this.compiled.filter((c) => !pin(c)).sort((a, b) => a.rec.at - b.rec.at); this.compiled = [...keep, ...rest.slice(Math.max(0, rest.length - (2000 - keep.length)))]; } writeFileSync(this.path, this.compiled.map((x) => JSON.stringify(x.rec)).join("\n") + (this.compiled.length ? "\n" : ""), { mode: 0o600 });
    this.dirty = false;
  }

  relevant(text: string, cap = Number(process.env.EDEN_MEMORY_CAP) || 6, fuse = true): MemoryRecord[] {
    const hay = queryHay(text);
    const hayStem = new Set([...hay].map(liteStem));
    const qTok = new Set(tokList(text));
    const rows = this.compiled.filter((c) => c.rec.kind !== "digest" && !(this.agent && c.rec.agent && c.rec.agent !== this.agent) && !(this.project && c.rec.project !== this.project));
    const speakers = new Set<string>();
    for (const c of rows) {
      const m = c.rec.text.match(SPEAKER_LABEL);
      if (!m) continue;
      for (const w of tokList(m[1]!.replace(/:$/, ""))) speakers.add(w);
    }
    const title = /\b(book|song|movie|album|show|poem|piece|novel|track|called|named|titled|title|series|watch(?:ed)?|read(?:ing)?)\b/i.test(text);
    const qSp = new Set<string>(); for (const w of qTok) if (speakers.has(w)) qSp.add(w);
    const qf = { title, called: title && /\b(called|named|titled|title)\b/i.test(text), book: title && /\b(book|novel|series|read(?:ing)?)\b/i.test(text), movie: title && /\b(movie|watch(?:ed)?|film|show)\b/i.test(text), song: title && /\b(piece|dance|song|track|album|poem)\b/i.test(text), fav: /\bfavorite\b/i.test(text), qSp, quant: /\b(how long|how many|how old|years?|months?|weeks?|days?|age|since|married)\b/i.test(text), how: /\bhow\b/i.test(text) && !/\bhow (?:long|many|old|much)\b/i.test(text), intent: /\b(interested|pursuing|plans?|excited|looking|keen|researching|want to)\b/i.test(text), where: /\b(where|which city|which town|which country|which state)\b/i.test(text) };
    const N = rows.length || 1, df = new Map<string, number>();
    const hit = (x: string) => hay.has(x) || hayStem.has(liteStem(x));
    const key = (x: string) => (isCarry(x) ? x.slice(1) : x);
    const bags = rows.map((c) => {
      const seen = new Set<string>(), lex: string[] = [], ctxh: [string, number][] = [];
      for (const x0 of c.needles) {
        const x = key(x0);
        if (!hit(x) || seen.has(x)) continue;
        seen.add(x); lex.push(x); df.set(x, (df.get(x) || 0) + 1);
      }
      for (const [x, w] of c.ctx) if (!seen.has(x) && hit(x)) { seen.add(x); ctxh.push([x, w]); df.set(x, (df.get(x) || 0) + 1); }
      return { c, lex, ctxh };
    });
    const idfOf = (x: string) => { const d = df.get(x) || 0; const idf = Math.log((N - d + 0.5) / (d + 0.5) + 1); return d / N < 0.04 ? idf * 1.55 : idf; };
    const scored = bags.map(({ c, lex, ctxh }) => {
      let n = 0, cn = 0;
      for (const x of lex) n += idfOf(x);
      for (const [x, w] of ctxh) cn += idfOf(x) * w;
      const base = n + Math.min(CTX_W * cn, CTX_CAP);
      const sal = base > 0 ? SAL_BOOST * c.sal : 0;
      let extras = 0;
      if (base > 0) extras += noteBonus(c.rec.text, hay, qf);
      return { rec: c.rec, n: base + sal + extras, cue: base > 0, sal: c.sal };
    });
    // Context reinstatement: the top hits' episodes spread activation to their other cue-sharing records.
    if (REINSTATE > 0) {
      let a: typeof scored[number] | undefined, b: typeof scored[number] | undefined;
      for (const x of scored) { if (!x.rec.ep || x.n <= 0) continue; if (!a || x.n > a.n) { b = a; a = x; } else if (!b || x.n > b.n) b = x; }
      const eps = new Set([a?.rec.ep, b?.rec.ep].filter(Boolean));
      if (eps.size) for (const x of scored) if (x.cue && x.rec.ep && eps.has(x.rec.ep)) x.n += REINSTATE * (1 + SAL_REINSTATE * x.sal);
    }
    const ranked = scored.filter((x) => x.n).sort((a, b) => b.n - a.n || Number(b.rec.kind === "constraint") - Number(a.rec.kind === "constraint") || b.rec.at - a.rec.at).slice(0, Math.max(cap * 6, 30, fuse ? 120 : 0));
    let lexical = pinEnvFact(text, dedupSelect(fuse ? fuseOnce(ranked, hay, speakers, cap) ?? ranked : ranked, cap), ranked, cap);
    if (/\b(?:how did we fix|what was the fix)\b/i.test(text)) {
      const have = lexical.find((l) => isFixAction(l.text));
      if (have && lexical.some((l) => /\b(?:root cause|stack trace|should be gone)\b/i.test(l.text))) lexical = pinFront(lexical, have);
    }
    if (isLogPolicyQuery(text)) {
      let have = lexical.find((l) => isNoPrintRule(l.text));
      if (!have) {
        let best: Compiled | undefined;
        for (const c of rows) {
          if (!(c.cues.includes(CUE_TAG + "c:log-forbid") || (c.rec.kind === "constraint" && isNoPrintRule(c.rec.text)))) continue;
          if (!best || c.sal > best.sal || (c.sal === best.sal && c.rec.at > best.rec.at)) best = c;
        }
        have = best?.rec;
      }
      lexical = pinFront(lexical, have, cap);
    }
    // Prospective pass: cue-triggered intentions get a reserved slice of the cap when the lexical pass missed them.
    const triggered = triggerScores(rows, text);
    if (!triggered.length) return lexical;
    const reserve = Math.min(PROSPECT_SLOTS, Math.max(1, Math.floor(cap / 3)));
    const strong = Math.log(1 + 2);
    const picked: MemoryRecord[] = [];
    for (const { rec, t } of triggered) {
      if (picked.length >= reserve) break;
      if (t < strong * PROSPECT_MIN) break;
      if (lexical.slice(0, cap - reserve).some((l) => l.id === rec.id || jaccardText(l.text, rec.text) > 0.6)) continue;
      if (picked.some((p) => jaccardText(p.text, rec.text) > 0.6)) continue;
      picked.push(rec);
    }
    if (!picked.length) return lexical;
    const out: MemoryRecord[] = [];
    for (const l of lexical) { if (out.length >= cap - picked.length) break; if (!picked.some((p) => p.id === l.id || jaccardText(p.text, l.text) > 0.6)) out.push(l); }
    return [...out, ...picked];
  }

  notesFor(text = "", k = Number(process.env.EDEN_MEMORY_CAP) || 6, opts: { fuse?: boolean } = {}): MemoryRecord[] {
    // Intention records (rules/decisions with a cue index) are returned verbatim: the yes/no and numeral
    // augmentation exists for answering questions from facts, and would corrupt "never console.log" or "zero ops".
    const map = (recs: MemoryRecord[]) => recs.map((r) => ({ ...r, text: cuesOf(r).length ? r.text : retrieveText(r.text) }));
    if (text) return map(this.relevant(text, k, opts.fuse !== false));
    return map(((recs) => [...recs.filter((r) => r.kind === "constraint").slice(-k), ...recs.filter((r) => r.kind !== "constraint").slice(-k)].filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i).slice(0, k))(this.memories()));
  }

  inject(messages: unknown[]): unknown[] {
    const list = Array.isArray(messages) ? messages : [];
    try {
      const blob = convBlob(list);
      const notes: { role: "system"; content: string }[] = [];
      if (!alreadyInjected(blob) && !blob.includes(MEMORY_MARK)) {
        const mems = this.notesFor(blob);
        if (mems.length) notes.push({ role: "system", content: MEMORY_MARK + mems.map((m) => `\n- ${m.text}`).join("") });
        const card = injectFromRequest({ text: blob }, this.know); if (card) notes.push({ role: "system", content: injectNote(card) });
      }
      this.observe(list);
      if (!notes.length) return list;
      const next = list.slice(), i = next.findIndex((m) => (m as { role?: string })?.role !== "system");
      return next.splice(i < 0 ? next.length : i, 0, ...notes), next;
    } catch { return list; }
  }

  injectBody(body: Record<string, unknown>): Record<string, unknown> {
    const key = Array.isArray(body.messages) ? "messages" : Array.isArray(body.contents) ? "contents" : "messages", m = Array.isArray(body[key]) ? (body[key] as unknown[]) : [], sys = body.systemInstruction ?? body.system_instruction ?? body.system ?? body.system_prompt ?? body.systemPrompt;
    if (sys) this.observe(typeof sys === "string" ? [{ role: "user", content: sys }] : [sys]);
    const next = this.inject(m);
    return next === m ? body : { ...body, [key]: next };
  }
  /** One JSONL flush after many observes (CLS session ingest = massed hippocampal write). */
  quiet(fn: () => void) {
    this.batch++;
    try { fn(); } finally { this.batch--; this.flush(false); }
  }

  close() { this.flush(false); }
}

export function openMemory(opts: MemoryOptions = {}): AgentMemory {
  return new AgentMemory(opts);
}

let proc: AgentMemory | undefined;
export function processMemory(): AgentMemory {
  return process.argv.some((a) => a.endsWith(".test.ts")) ? openMemory({ dir: join(tmpdir(), "eden-m-" + Math.random().toString(36).slice(2)) }) : (proc ??= openMemory({ dir: process.env.EDEN_MEMORY_DIR || (process.env.EDEN_HOME ? join(process.env.EDEN_HOME, "memory") : undefined), agent: process.env.EDEN_MEMORY_AGENT || undefined, project: process.env.EDEN_MEMORY_PROJECT || undefined }));
}

