import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { alreadyInjected, injectFromRequest, injectNote } from "../packages/know/src/inject";
import { knowQuery } from "../packages/know/src/query";

export const MEMORY_MARK = "Eden Memory:";

export type MemoryKind = "fact" | "preference" | "episode" | "procedure" | "constraint" | string;
export type MemoryRecord = { id: string; text: string; kind: MemoryKind; tags: string[]; agent?: string; project?: string; at: number };
export type KnowSearch = { search(q: string, k?: number): { s: string; p: string; o: string; e: string; url?: string }[]; close?: () => void };
export type MemoryOptions = { dir?: string; know?: KnowSearch; agent?: string; project?: string };
export type QueryHit = { text: string; source: "memory" | "know"; url?: string; id?: string };

type Compiled = { rec: MemoryRecord; needles: string[] };

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

function titleBonus(query: string, note: string): number {
  if (!/\b(book|song|movie|album|show|poem|piece|novel|track|called|named|titled|title|series|watch(?:ed)?|read(?:ing)?)\b/i.test(query)) return 0;
  if (!/"[^"]{3,80}"/.test(note)) return 0;
  let n = 2;
  if (/\b(called|named|titled|title)\b/i.test(query) && /\b(called|named|titled)\b/i.test(note)) n += 2;
  if (/\b(book|novel|series|read(?:ing)?)\b/i.test(query) && /\b(book|read(?:ing)?|novel)\b/i.test(note)) n += 1.5;
  if (/\b(movie|watch(?:ed)?|film|show)\b/i.test(query) && /\b(watch(?:ed)?|movie|film|show)\b/i.test(note)) n += 1.5;
  if (/\b(piece|dance|song|track|album|poem)\b/i.test(query) && /\b(piece|dance|song|track|album|poem|perform)\b/i.test(note)) n += 1.5;
  return n;
}

function favBonus(query: string, note: string): number {
  if (!/\bfavorite\b/i.test(query)) return 0;
  return /\b(loved|love|loves|fave|favourite)\b/i.test(note) ? 1 : 0;
}


function speakerBonus(query: string, note: string, speakers: Set<string>): number {
  const q = new Set(tokList(query).filter((w) => speakers.has(w)));
  if (!q.size) return 0;
  const m = note.match(SPEAKER_LABEL);
  if (!m) return 0;
  const sp = tokList(m[1]!.replace(/:$/, ""));
  return sp.some((w) => q.has(w)) ? 3 : 0;
}


function quantBonus(query: string, note: string): number {
  if (!/\b(how long|how many|how old|years?|months?|weeks?|days?|age|since|married)\b/i.test(query)) return 0;
  return /\b\d{1,4}\b/.test(note) ? 1.5 : 0;
}


function retrieveText(text: string): string {
  return text
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
}


function howBonus(query: string, note: string): number {
  if (!/\bhow\b/i.test(query) || /\bhow (?:long|many|old|much)\b/i.test(query)) return 0;
  return /\b(by |through |using |via |with my |with our |carving|priorit|practice|routine|habit|steps?|process)\b/i.test(note) ? 1.5 : 0;
}


function intentBonus(query: string, note: string): number {
  if (!/\b(interested|pursuing|plans?|excited|looking|keen|researching|want to)\b/i.test(query)) return 0;
  return /\b(looking into|keen|excited|want to|interested|plan(?:s|ning|ned)?|research(?:ing|ed)?|pursue|pursuing)\b/i.test(note) ? 3 : 0;
}


function whereBonus(query: string, note: string): number {
  if (!/\b(where|which city|which town|which country|which state)\b/i.test(query)) return 0;
  return /\b(in |at |to |from |visited|trip to|live(?:s|d)? in|moved to|based in|city|town|mountains?|park)\b/i.test(note) ? 2.5 : 0;
}

/**
 * Redundancy-aware top-K selection. Plain top-N-by-score can crowd the cap with several near-duplicate
 * records restating the same fact while a query that needs *coverage* of several distinct facts about the
 * same subject (list/aggregate questions -- "What has Melanie painted?", "What activities has X done?")
 * loses the long tail to those restatements. Walk the score-ordered pool and skip a candidate only when
 * it's a near-duplicate (high token-Jaccard) of something already picked, so a genuinely distinct fact
 * further down the ranking gets pulled forward into the cap instead of a third restatement of #1. Order is
 * otherwise untouched, and skipped duplicates backfill the cap if too few distinct candidates exist, so
 * this never returns fewer results than plain top-K would.
 */
/**
 * Topic fusion: when more scored candidates share a single distinctive query term than the cap can hold
 * (e.g. a dozen sentence-level records all mentioning "painting"), plain top-K crowds every slot with
 * restatements of the same topic and starves other angles of the query, while an aggregate/list question
 * ("What has Melanie painted?") needs the union of what each of those records says, not just the single
 * best-scoring one. Pack the crowd's distinct text into one composite record instead -- this both recovers
 * the union of evidence (helps aggregate answers) and frees the remaining cap slots for other needles.
 */
function fuseOnce(scored: { rec: MemoryRecord; n: number }[], hay: Set<string>, speakers: Set<string>, cap: number, usedTerms: Set<string>): { rec: MemoryRecord; n: number }[] | null {
  if (scored.length <= cap) return null;
  let bestTerm = "", bestMembers: { rec: MemoryRecord; n: number }[] = [];
  for (const term of hay) {
    if (term.length < 3 || speakers.has(term) || usedTerms.has(term)) continue;
    const members = scored.filter((x) => x.rec.kind !== "digest" && tokList(x.rec.text).includes(term));
    if (members.length > bestMembers.length) { bestMembers = members; bestTerm = term; }
  }
  if (bestMembers.length <= cap) return null;
  usedTerms.add(bestTerm);
  const take = bestMembers.slice(0, 100);
  const seen = new Set<string>();
  const parts: string[] = [];
  let budget = 5000;
  for (const m of take) {
    const t = m.rec.text.replace(/^[A-Z][A-Za-z0-9 /._-]{1,32}:\s*/, "");
    const dk = t.toLowerCase().slice(0, 40);
    if (seen.has(dk)) continue;
    seen.add(dk);
    if (t.length > budget) continue;
    parts.push(t);
    budget -= t.length;
  }
  if (parts.length < 2) return null;
  const label = take[0]!.rec.text.match(SPEAKER_LABEL)?.[1];
  const fusedRec: MemoryRecord = {
    id: `fuse:${bestTerm}:${take[0]!.rec.id}`,
    text: (label ? `${label} ` : "") + parts.join(" | "),
    kind: "fact",
    tags: [],
    at: Math.max(...take.map((x) => x.rec.at)),
  };
  const fusedN = Math.max(...take.map((x) => x.n)) + 0.5;
  const memberIds = new Set(take.map((x) => x.rec.id));
  const rest = scored.filter((x) => !memberIds.has(x.rec.id));
  return [...rest, { rec: fusedRec, n: fusedN }].sort((a, b) => b.n - a.n);
}

function fuseIfCrowded(scored: { rec: MemoryRecord; n: number }[], hay: Set<string>, speakers: Set<string>, cap: number): { rec: MemoryRecord; n: number }[] {
  const usedTerms = new Set<string>();
  let cur = scored;
  for (let round = 0; round < 1; round++) {
    const next = fuseOnce(cur, hay, speakers, cap, usedTerms);
    if (!next) break;
    cur = next;
  }
  return cur;
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
          const t = ["text","content","llmContent","alt","name","caption","title","filename","url","href","source","uri","id","mimeType","value"].map((k) => (b as Record<string, unknown>)[k]).find((v) => typeof v === "string" && v);
          if (t) parts.push(t as string);
        }
      }
    }
    const r = o.reasoning_content ?? o.thinking ?? o.reasoning; if (typeof r === "string" && r) parts.push(r);
    const si = o.systemInstruction ?? o.system_instruction; if (typeof si === "string" && si) parts.push(si);
    else if (si && typeof si === "object") { const ps = (si as Record<string, unknown>).parts; if (Array.isArray(ps)) for (const b of ps) { const t = b && typeof b === "object" ? ["text","content","value"].map((k) => (b as Record<string, unknown>)[k]).find((v) => typeof v === "string" && v) : undefined; if (typeof t === "string") parts.push(t); } }
    if (Array.isArray(o.candidates)) for (const x of o.candidates as Record<string, unknown>[]) { const ps = (x?.content as Record<string, unknown> | undefined)?.parts; if (Array.isArray(ps)) for (const b of ps) { const t = b && typeof b === "object" ? ["text","content","llmContent","value"].map((k) => (b as Record<string, unknown>)[k]).find((v) => typeof v === "string" && v) : undefined; if (typeof t === "string") parts.push(t); } }
  }
  return parts.join("\n");
}

const CHAT = /^(ok|okay|thanks|thank you|got it|sure|yeah|yep|please\b|hmm|wait|anyway|nah|hey|yo|lol|haha|lmao|nope|np|wow|whoa|idk|dunno|alright|gotcha|sounds good|lgtm|ack|cheers|ty|gg|brb|nvm|omg|kk|yup|thx|ttyl|smh|wfm|idc|ngl|fr|ikr|meh|ugh|welp|yikes|oops|huh)\b/i;
const SPEAKER_LABEL = /^([A-Z][A-Za-z0-9 /._-]{1,32}:)(?=\s)/;

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
  let whole = blob.trim().replace(/\s+/g, " ");
  if (SPEAKER_LABEL.test(whole) && whole.endsWith("?") && /[.!]/.test(whole.slice(0, -1))) whole = whole.replace(/\s+[^.!?]+\?\s*$/, "").trim();
  const labeledWhole = SPEAKER_LABEL.test(whole) && whole.length <= 800 && !whole.endsWith("?");
  const label = whole.match(SPEAKER_LABEL)?.[1];
  for (const raw of labeledWhole ? [whole] : blob.split(/(?<=[.!\n])\s+/)) {
    let t = raw.trim().replace(/\s+/g, " ").replace(/^(i think|i believe|i guess|maybe|perhaps|tbh|imo|btw,|fwiw,)\s+/i, "");
    if (t.length < 8 || t.length > (labeledWhole ? 800 : 400) || t.startsWith("{") || t.startsWith("[") || t.startsWith("```") || t.startsWith("http") || t.startsWith("#") || /^(const|let|import |export |function |npm |pnpm |bun |git |cd |curl |yarn |npx |sudo |echo |cat |ls )\b/.test(t) || t.includes(MEMORY_MARK) || t.includes("Eden Know:") || /\bleftover intern firm\b/i.test(t) || /^(thinking about|you are|we are|this is|it is|that is|there (is|are)|i am going|i want to|this means|let me|i'll|let's|we will|look at|can you|could you|would you|tell me|fix the|add the|we need to|we're|cool, |nice, |great, |awesome, |perfect, )\b/i.test(t) || /\b(?:sk-|ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9]/.test(t) || CHAT.test(t)) continue;
    if (label && !SPEAKER_LABEL.test(t)) t = `${label} ${t}`;
    const rem = t.match(/\bremember(?: that)?\s+(.+)/i); if (rem) t = rem[1].trim();
    else if (t.endsWith("?") || !(/\b(prefer(?:s|red)?|never |always |must |from now on|note that|don'?t |ran out|i want |fyi|also,|we should |make sure |stands for| aka |called |confirmed |decided |settled on|going with|agreed to|switched to|standardized on|standardized to|rolled back|pinned to|migrated to|reverted to|deprecated |cut over to|turned on|turned off|enabled the|disabled the|shipped |assigned |owned by|belongs to|due on|due by|deadline|blocked on|depends on|required |lives in|live in|stays in|stay in|moved to|based in|located |works (?:at|for)|work (?:on|at|for)|skip dairy|vegetarian|named |our dog|my dog|reports to|on-call|\bci\b|runs on|pagerduty|slack |cluster |namespace |region |vpc |timezone|branch |repo |org |team |channel |workspace |project |sprint |ticket |issue |hotfix |incident |sev[0-3]|p[0-3] |outage |pager |rollback |deployed |feature flag|kill switch|launchdarkly|maintenance |degraded |slo |sla |quota |budget |capacity |limit |rate.?limit|retr(?:y|ies|ied)|backoff|dri |owner |circuit.?breaker|webhook|endpoint|crontab|cronjob|version |k8s |kubernetes|configmap|helm |terraform|pulumi|cloudformation|iam |cdk |ansible|gcp |gcloud |azure |snowflake|bigquery|datadog|kafka|redshift|pubsub|rabbitmq|redis|postgres|elasticsearch|mongodb|mysql|dynamodb|sentry|grafana|prometheus|newrelic|honeycomb|otel|opentelemetry|jaeger|zipkin|cloudwatch|splunk|lambda|sqs|sns|cloudtrail|kinesis|ecs|step.?functions?|eks|fargate|rds|aurora|secrets.?manager|cloudfront|elasticache|alb|route.?53|api.?gateway|waf|ecr|nlb|elb|s3|kms|athena|glue|cognito|ebs|emr|sagemaker|bedrock|aws.?batch|eventbridge|codebuild|codepipeline|codedeploy|appconfig|amplify|appsync|xray|codecommit|codeartifact|efs|fsx|databricks|clickhouse|prestodb|trino|duckdb|flink|cassandra|neo4j|scylla|cockroach|vitess|tidb|spanner|cosmosdb|firestore|bigtable|memcached|consul|etcd|zookeeper|vault|nomad|istio|envoy|linkerd|traefik|kong|cilium|argocd|fluxcd|knative|calico|tekton|crossplane|kustomize|harbor|helmfile|thanos|mimir|cortex|fluentbit|fluentd|filebeat|logstash|opensearch|metricbeat|qdrant|weaviate|milvus|pinecone|typesense|meilisearch|pgvector|faiss|lancedb|chromadb|solr|nats|pulsar|mosquitto|emqx|airflow|dagster|prefect|temporal|flyte|kubeflow|mlflow|feast|wandb|dvc|huggingface|langsmith|llamaindex|ollama|vllm|sglang|tgi|tensorrt|triton|ggml|gguf|llamafile|exllamav2|awq|gptq|bitsandbytes|flashattn|deepspeed|fsdp|megatron|horovod|nccl|accelerate|xla|ship from|ships from)\b/i.test(t) || (/\b(is|are|was|were|needs?|uses?|will be|ha(?:s|ve) been)\b/i.test(t) && /[A-Z][a-zA-Z]|:\/\/|\w+\.\w+|\d{2,}/.test(t)) || /^[A-Z][A-Za-z0-9 /._-]{1,32}:\s+\S/.test(t) || /^\d+[.)]\s+.{8,}/.test(t) || /^[-*]\s+.{8,}/.test(t) || /"[^"]{4,80}"\s+(?:is|means|aka)/i.test(t) || /@[\w.-]+\.[a-z]{2,}/i.test(t) || /\b20\d{2}-\d{2}-\d{2}\b/.test(t) || /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(t) || /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(t) || /\$\d{2,}/.test(t) || /(?:~\/|\/(?:Users|home|opt|usr|var|etc)\/)[\w./-]+/.test(t) || /\b[A-Z][A-Z0-9_]{2,}=\S/.test(t) || /\bport\s+\d{2,5}\b/i.test(t) || /\b[\w.-]+\.(?:json|ya?ml|toml|env)\b/.test(t) || /\b[\w-]+\.(?:com|io|dev|internal|local)\b/.test(t) || /\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\b/.test(t) || /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/.test(t) || /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(t) || /\b[0-9a-f]{40}\b/.test(t) || /\b(?:\*|\d{1,2})(?:\s+(?:\*|\d{1,2})){4}\b/.test(t) || /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i.test(t) || /\bv\d+\.\d+\.\d+\b/i.test(t) || /\b[\w-]+\.[\w-]+\.svc(?:\.cluster\.local)?\b/.test(t) || /\barn:aws:[a-z0-9-]+:/i.test(t) || looksNarrative(t))) continue;
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
 * Context-carry: a stored statement inherits needles from the turn before it (the question it answers).
 * Questions are never stored, so their frame would otherwise be lost. Two tiers:
 *   "^word"  question-sentence tokens of the previous turn   (weight CARRY_W)
 *   "~word"  remaining tokens of the previous turn            (weight CARRY_W2)
 */
const CARRY_Q = "^", CARRY_R = "~";
const CARRY_W = Number(process.env.EDEN_CARRY_W ?? 1);
const CARRY_W2 = Number(process.env.EDEN_CARRY_W2 ?? 0);
const CARRY_MAX = 24;
const isCarry = (t: string) => t.startsWith(CARRY_Q) || t.startsWith(CARRY_R);

function carryTokens(text: string): string[] {
  const label = text.match(SPEAKER_LABEL)?.[1];
  const sp = new Set(label ? tokList(label.replace(/:$/, "")) : []);
  const ok = (w: string, seen: Set<string>) => !(w.length < 3 || STOP.has(w) || QUERY_SKIP.has(w) || sp.has(w) || seen.has(w));
  const seen = new Set<string>(), out: string[] = [];
  for (const w of tokList((text.match(/[^.!?\n]*\?/g) ?? []).join(" "))) if (ok(w, seen) && out.length < CARRY_MAX) { seen.add(w); out.push(CARRY_Q + w); }
  if (CARRY_W2 > 0) { let n = 0; for (const w of tokList(text)) if (ok(w, seen) && n < CARRY_MAX) { seen.add(w); out.push(CARRY_R + w); n++; } }
  return out;
}

function compile(rec: MemoryRecord): Compiled {
  const own = new Set([...rec.tags.filter((t) => !isCarry(t)), ...tokList(rec.text).filter((w) => w.length >= 3 && !STOP.has(w))]);
  const carried = rec.tags.filter((t) => isCarry(t) && !own.has(t.slice(1)));
  return { rec, needles: [...own, ...carried] };
}

function load(path: string): Compiled[] {
  if (!existsSync(path)) return [];
  const out: Compiled[] = [];
  for (const t of readFileSync(path, "utf8").split("\n")) try {
    const rec = JSON.parse(t) as MemoryRecord;
    if (rec?.id && rec.text) out.push(compile(rec));
  } catch {}
  return out;
}

/**
 * Slot consolidation (episodic → semantic). Each labeled turn is mined for slot fillers and folded into one
 * per-(speaker, slot) digest record that supersedes its previous version. Aggregate questions
 * ("what activities…", "where has X…") are answered by the digest, not by any single turn.
 */
type Slot = "places" | "made" | "activities" | "names" | "titles";
/** Query words that signal an aggregate question over a slot; used only as a gate (never as scored needles). */
const SLOT_FRAME: Record<Slot, RegExp> = {
  places: /\b(where|places?|visited|visits?|been to|travel(?:ed|led|s)?|trips?|camped|cities|city|countries|country|areas|locations|spots|destinations)\b/i,
  made: /\b(made|make|makes|painted|paints?|built|cooked|baked|bought|wrote|created|crafted|drew|desserts?|dishes|meals|creations|pieces|projects|items|things)\b/i,
  activities: /\b(activit(?:y|ies)|hobb(?:y|ies)|interests?|enjoys?|sports?|exercises?|pastimes?|instruments?|plays?|partake|participates?|does|done|do)\b/i,
  names: /\b(who|names?|people|friends|met|pets?|dogs?|cats?|kids|children|family|artists?|bands?|members|colleagues|mentors?|characters)\b/i,
  titles: /\b(books?|movies?|films?|songs?|albums?|shows?|series|novels?|titles?|titled|called|read|reading|watched|watching|poems?)\b/i,
};
const PLACE_LEX = new Set("beach beaches mountain mountains forest forests park parks lake lakes river rivers ocean sea coast island islands desert hills valley canyon trail trails museum museums gym church shelter studio school college university campus hospital office cafe coffee shop restaurant bar store shop market mall theater theatre cinema stadium arena festival concert camp campsite campground city town village downtown neighborhood library zoo aquarium garden gardens farm ranch cabin hotel airport station hometown country countryside apartment house home kitchen backyard rooftop pool club gallery bookstore bakery diner pub temple cathedral castle palace bridge harbor pier woods meadow field fields cliff cliffs waterfall spring springs bay cave caves resort spa lodge".split(" "));
const ABSTRACT = new Set("difference impact progress sense decision effort change changes friends time money plans mistake mistakes choice choices point sure fun way ways list note promise peace most happen happens deal move moves memories memory living history career name names news friend appearance debut headway room space contribution contributions connection connections amends comeback breakthrough exception statement case start finish trip journey".split(" "));
const DIGEST_BONUS = Number(process.env.EDEN_DIGEST_BONUS ?? 9);
const SLOT_LABEL: Record<Slot, string> ={ places: "places", made: "made", activities: "activities", names: "names", titles: "titles" };
const ING_SKIP = new Set("going being having getting doing something anything everything nothing morning evening during thing things amazing interesting exciting inspiring stunning boring feeling looking thinking coming trying making taking talking saying telling working starting sharing seeing hoping wishing sending giving bringing meeting keeping helping finding learning moving living loving growing wondering knowing planning turning putting happening according including following spending annoying rewarding frustrating challenging satisfying refreshing calming comforting encouraging uplifting disheartening heartwarming heartbreaking soaring touching bustling fulfilling surrounding evolving striving reminiscing pursuing spreading speaking understanding celebrating sticking letting trusting falling appreciating checking contacting reaching jumping throwing pouring stressing experimenting connecting cheering stepping wrapping winding hanging chatting tackling improving housing inviting gaining raising wagging chilling missing waiting hearing".split(" "));
const PLACE_SKIP = new Set("and or but last next every each again yesterday today tomorrow tonight with for of on at in by like into after ago since until while when where soon later now then just also very really quite so too more most much many some any the a an my our his her their me you us them it there here order touch love least all fact life time end future moment way past beginning same world process day days week weeks weekend month months year years meantime morning evening night afternoon mind heart case point terms addition general spite front back top bottom middle side sight person turn charge control common return response".split(" "));
const CAL = new Set("monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december mon tue wed thu fri sat sun jan feb mar apr jun jul aug sep sept oct nov dec".split(" "));

function slotFillers(body: string): Partial<Record<Slot, string[]>> {
  const out: Partial<Record<Slot, string[]>> = {};
  const add = (s: Slot, v: string) => { const x = v.trim().replace(/[.,!?;:'"]+$/g, "").trim(); if (x.length >= 3 && x.length <= 40 && !/\d/.test(x)) (out[s] ??= []).push(x); };
  const unquoted = body.replace(/["“][^"”]*["”]/g, " ");
  // places: preposition + (det) + place-type noun, or preposition + Proper Noun
  for (const m of unquoted.matchAll(/\b(?:at|in|near|around|across|from|to|into)\s+(?:the|a|an|my|our|his|her|their|some|this|that)\s+([a-z]+)(?:\s+([a-z]+))?\b/gi)) { const a = m[1]!.toLowerCase(), b = (m[2] || "").toLowerCase(); if (PLACE_LEX.has(a)) add("places", a); else if (PLACE_LEX.has(b)) add("places", `${a} ${b}`); }
  for (const m of unquoted.matchAll(/\b(?:at|in|near|around|across|from|to|into|visited|visiting|visit)\s+([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\b/g)) { const w = m[1]!; if (!CAL.has(w.toLowerCase()) && !/^(?:The|That|This|These|Those|What|When|Where|Which|How|Why|Who|But|And|Also|Just|Then|There|Here|Now|Yes|Yeah|Wow|Thanks|Hey|Congrats|Sounds|Glad|Good|Great|Awesome|Definitely|Sure|Okay|Hope|Love|Looking|Hopefully|Maybe|Anyway|Well|Cool|Nice|Happy|Sorry|Absolutely|Excited|Btw|Speaking)$/.test(w)) add("places", w); }
  // made: concrete creation/acquisition verbs + object head (skip abstract heads)
  for (const m of unquoted.matchAll(/\b(?:painted|baked|cooked|built|knitted|sewed|crafted|drew|bought|wrote|sculpted|brewed|grilled|roasted|whipped up|carved|designed|assembled)\s+(?:up\s+)?(?:a|an|the|some|this|these|that|those|my|our|his|her|their|its|any|every|another|new|few|couple of|lots of|fresh|homemade|delicious|yummy|beautiful|little|big|cute|tiny|small)?\s*(?:(?:a|an|the|some|my|our|his|her|their|new|homemade|delicious|yummy|beautiful|little|big|cute|tiny|small|fresh)\s+)?([a-z][a-z-]+(?:\s+[a-z][a-z-]+){0,2}(?:(?:,\s*|\s+(?:and|or)\s+|,\s*(?:and|or)\s+)[a-z][a-z-]+(?:\s+[a-z][a-z-]+){0,2})*)\b/gi)) {
    for (const part of m[1]!.toLowerCase().split(/\s*,\s*(?:and|or)\s+|\s*,\s*|\s+(?:and|or)\s+/)) {
      const ws = part.trim().split(/\s+/).filter((t) => t && !PLACE_SKIP.has(t) && !/^(?:it|them|me|you|us|that|this|those|these|to|of|for|by|with|and|so|up|out|in|on|at|from|into|myself|ourselves|him|her|last|next|ago|yesterday|today|recently|lately)$/.test(t));
      const h = ws.slice(-2).join(" ");
      if (h && !ABSTRACT.has(ws[ws.length - 1]!) && !/^(?:[a-z]+ing|is|was|be|get|go|see|do|have|has|had|feel|felt|think|thought)$/.test(ws[ws.length - 1]!)) add("made", h);
    }
  }
  // activities: gerunds/nouns only inside activity frames (go/love/enjoy/into/started/tried/play …)
  for (const m of unquoted.matchAll(/\b(?:go|went|goes|been|love|loves|loved|enjoy|enjoys|enjoyed|into|started|start|tried|try|trying|took up|take up|practice|practicing|teach|teaching|learn|learning)\s+(?:some\s+|more\s+|a\s+bit\s+of\s+|a\s+lot\s+of\s+|the\s+)?([a-z]{4,}(?:\s+[a-z]{4,})?(?:(?:,\s*|\s+(?:and|or)\s+|,\s*(?:and|or)\s+)[a-z]{4,}(?:\s+[a-z]{4,})?)*)\b/gi)) {
    for (const part of m[1]!.toLowerCase().split(/\s*,\s*(?:and|or)\s+|\s*,\s*|\s+(?:and|or)\s+/)) {
    const ws = part.trim().split(/\s+/); const w = ws[0]!;
    if (!w || STOP.has(w) || PLACE_SKIP.has(w) || ING_SKIP.has(w) || /^(?:that|this|about|with|being|having|what|when|where|hearing|seeing|talking|meeting|chatting|there|them|they|these|those|through|because|which|while|sure|forward|back|ahead|home|well|good|great|again|around|together|over|down|much|myself|yourself|ourselves)$/.test(w)) continue;
    if (/ing$/.test(w) || ws.length === 1) add("activities", w); else add("activities", ws.join(" "));
    }
  }
  for (const m of unquoted.matchAll(/\b([a-z]{4,})\s+(?:class|classes|lessons?|trip|trips|sessions?|club|group|workshop|workshops|tournaments?|competitions?|practice|routine|gear|shoes|boots|kit|equipment|studio|course|courses)\b/gi)) { const w = m[1]!.toLowerCase(); if (!ING_SKIP.has(w) && !STOP.has(w) && !PLACE_SKIP.has(w) && !/^(?:this|that|these|those|first|second|third|whole|entire|same|other|another|local|online|free|great|good|nice|fun|hard|tough|long|short|weekly|daily|regular|favorite|little|small|big)$/.test(w)) add("activities", w); }
  for (const m of unquoted.matchAll(/\bplay(?:s|ed|ing)?\s+(?:the\s+)?([a-z]{4,})\b/gi)) { const w = m[1]!.toLowerCase(); if (!STOP.has(w) && !/^(?:with|around|along|some|more|again|together|games?|time|around)$/.test(w)) add("activities", w); }
  // names: capitalized tokens not at sentence start, not calendar words
  for (const m of unquoted.matchAll(/(?<=[^.!?\n]\s|,\s)([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\b/g)) { const w = m[1]!; if (!CAL.has(w.split(" ")[0]!.toLowerCase()) && !/^(?:The|That|This|These|Those|What|When|Where|Which|How|Why|Who|But|And|Also|Just|Then|There|Here|Now|Yes|Yeah|Wow|Thanks|Hey|Congrats|Sounds|Glad|Good|Great|Awesome|Definitely|Sure|Okay|Hope|Love|Looking|Hopefully|Maybe|Anyway|Well|Cool|Nice|Happy|Sorry|Absolutely|Excited|Btw|Speaking|Bet|Even|Let|Man|Guess|Long|Big|Check|Keep|Hang|Bye|Take|Have|Got|See|Talk|Thank|Miss|Best|Same|Haha|Lol|Omg|Aww|Ooh|Oh|Ahh|Hah|Yep|Yup|Nope|Nah|Right|Totally|Exactly|True|Agreed)$/.test(w)) add("names", w); }
  for (const m of body.matchAll(/["“]([^"”]{3,60})["”]/g)) add("titles", m[1]!);
  return out;
}

function subjectKey(text: string): string | null {
  const k = text.trim().match(/^(.{4,80}?)\s+(?:is|are|was|were|prefers?|uses?|lives in|live in|stays in|stay in|moved to|belongs to|owned by|ship from|ships from)\s+\S/i)?.[1]?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "";
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
  private speakerNames = new Set<string>();

  constructor(opts: MemoryOptions = {}) {
    this.know = opts.know; this.agent = opts.agent; this.project = opts.project;
    mkdirSync((this.dir = opts.dir || join(homedir(), ".eden", "memory")), { recursive: true });
    try { chmodSync(this.dir, 0o700); } catch {}
    this.compiled = load((this.path = join(this.dir, "memories.jsonl")));
  }

  memories(): MemoryRecord[] {
    return this.compiled.map((c) => c.rec).filter((r) => !this.project || r.project === this.project);
  }

  remember(text: string, opts: { kind?: MemoryKind; tags?: string[]; id?: string; agent?: string; project?: string } = {}): MemoryRecord {
    const rec: MemoryRecord = { id: opts.id || `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, text: String(text || "").trim(), kind: opts.kind || "fact", tags: (opts.tags || []).map((t) => t.toLowerCase()), agent: opts.agent || this.agent, project: opts.project || this.project, at: Date.now() };
    if (!rec.text) return rec;
    const c = compile(rec), i = this.compiled.findIndex((x) => x.rec.id === rec.id);
    i >= 0 && this.compiled.splice(i, 1);
    return this.compiled.push(c), this.persist(), rec;
  }

  forget(id: string): boolean {
    const n = this.compiled.length;
    this.compiled = this.compiled.filter((c) => c.rec.id !== id && c.rec.text !== id && c.rec.text.toLowerCase() !== id.toLowerCase() && subjectKey(c.rec.text) !== id.toLowerCase());
    return this.compiled.length !== n && (this.persist(), true);
  }

  observe(messages: unknown[]): MemoryRecord[] {
    const list = (Array.isArray(messages) ? messages : []).filter((m) => (m && typeof m === "object" ? (m as { role?: string }).role : "") !== "system");
    const blob = convBlob(list);
    const out: MemoryRecord[] = [];
    const carry = process.env.EDEN_CARRY_MODE === "off" ? [] : this.carry;
    this.carry = carryTokens(blob.trim().replace(/\s+/g, " ").slice(0, 2000));
    for (const text of extractDurable(blob)) {
      if (this.compiled.some((c) => (!this.project || c.rec.project === this.project) && c.rec.text.toLowerCase() === text.toLowerCase())) continue;
      const key = subjectKey(text);
      if (key) this.compiled = this.compiled.filter((c) => (this.project && c.rec.project !== this.project) || subjectKey(c.rec.text) !== key);
      out.push(this.remember(text, { kind: /\b(prefer|never |always |don'?t |must |from now on)\b/i.test(text) ? "constraint" : /\b(ran out|shipped |decided |settled on|going with|agreed to|switched to|standardized on|standardized to|rolled back|pinned to|migrated to|reverted to|deprecated |cut over to|turned on|turned off|enabled the|disabled the)\b/i.test(text) ? "episode" : "fact", tags: carry.concat(tokList(text)).concat(([[/\bpull requests?\b/i, "pr"], [/\btimezone|pacific|utc\b/i, "tz"], [/@[\w.-]+\.[a-z]{2,}/i, "email"], [/\b(vegetarian|vegan|pescatarian|skip dairy|lactose|allerg|kosher|halal|gluten)\b/i, "diet"]] as const).flatMap(([re, t]) => re.test(text) ? [t] : [])) }));
      if (process.env.EDEN_DIGEST !== "off") { const m = text.match(SPEAKER_LABEL); if (m) this.consolidate(m[1]!.replace(/:$/, ""), text.slice(m[1]!.length)); }
    }
    return out;
  }

  /** Fold one labeled turn into the speaker's slot digests (superseding records `digest:<speaker>:<slot>`). */
  private consolidate(speaker: string, body: string) {
    const sp = speaker.trim();
    this.speakerNames.add(sp.toLowerCase());
    const fillers = slotFillers(body.replace(/\s+/g, " "));
    for (const slot of Object.keys(fillers) as Slot[]) {
      let items = fillers[slot]!;
      if (slot === "names") items = items.filter((n) => !this.speakerNames.has(n.toLowerCase()) && !this.speakerNames.has(n.split(" ")[0]!.toLowerCase()));
      if (!items.length) continue;
      const id = `digest:${sp.toLowerCase()}:${slot}`;
      const prev = this.compiled.find((c) => c.rec.id === id);
      const seen = new Set<string>(prev ? String(prev.rec.text.split(" — ")[1] || "").split(", ").map((x) => x.toLowerCase()) : []);
      const list = prev ? String(prev.rec.text.split(" — ")[1] || "").split(", ").filter(Boolean) : [];
      for (const it of items) { const k = it.toLowerCase(); if (!seen.has(k)) { seen.add(k); list.push(it); } }
      const kept = list.slice(-60);
      const text = `${sp}: ${SLOT_LABEL[slot]} — ${kept.join(", ")}`;
      if (prev && prev.rec.text === text) continue;
      this.remember(text, { id, kind: "digest", tags: [] });
    }
  }

  private persist() {
    if (this.compiled.length > 2000) { const keep = this.compiled.filter((c) => c.rec.kind === "constraint").sort((a, b) => a.rec.at - b.rec.at).slice(-2000); const rest = this.compiled.filter((c) => c.rec.kind !== "constraint").sort((a, b) => a.rec.at - b.rec.at); this.compiled = [...keep, ...rest.slice(Math.max(0, rest.length - (2000 - keep.length)))]; } writeFileSync(this.path, this.compiled.map((x) => JSON.stringify(x.rec)).join("\n") + (this.compiled.length ? "\n" : ""), { mode: 0o600 });
  }

  relevant(text: string, cap = Number(process.env.EDEN_MEMORY_CAP) || 6, fuse = true): MemoryRecord[] {
    const hay = queryHay(text);
    const hayStem = new Set([...hay].map(liteStem));
    // Digest gate: a slot digest competes only for aggregate questions about its speaker and slot.
    const qTok = new Set(tokList(text));
    const digestOk = (c: Compiled) => {
      if (c.rec.kind !== "digest") return true;
      const [, sp, slot] = c.rec.id.split(":");
      return !!sp && !!slot && qTok.has(sp.split(" ")[0]!) && SLOT_FRAME[slot as Slot]?.test(text) === true;
    };
    const rows = this.compiled.filter((c) => !(this.agent && c.rec.agent && c.rec.agent !== this.agent) && !(this.project && c.rec.project !== this.project) && digestOk(c));
    const speakers = new Set<string>();
    for (const c of rows) {
      const m = c.rec.text.match(SPEAKER_LABEL);
      if (!m) continue;
      for (const w of tokList(m[1]!.replace(/:$/, ""))) speakers.add(w);
    }
    const prefs = new Set([...hay].filter((h) => h.length >= 8 && !speakers.has(h)).map((h) => h.slice(0, 5)));
    const N = rows.length || 1, df = new Map<string, number>();
    // Prefix hit only when stems agree — blocks activities→activist collisions.
    const hit = (x: string) =>
      hay.has(x) ||
      hayStem.has(liteStem(x)) ||
      (x.length >= 8 && !speakers.has(x) && prefs.has(x.slice(0, 5)) && hayStem.has(liteStem(x)));
    const key = (x: string) => (isCarry(x) ? x.slice(1) : x);
    for (const c of rows) {
      const seen = new Set<string>();
      for (const x0 of c.needles) { const x = key(x0); if (hit(x) && !seen.has(x)) { seen.add(x); df.set(x, (df.get(x) || 0) + 1); } }
    }
    const scored = rows.map((c) => {
      let n = 0;
      const seen = new Set<string>();
      for (const x0 of c.needles) {
        const x = key(x0);
        if (!hit(x) || seen.has(x)) continue;
        seen.add(x);
        const d = df.get(x) || 0;
        let idf = Math.log((N - d + 0.5) / (d + 0.5) + 1);
        if (d / N < 0.04) idf *= 1.55;
        n += x0 === x ? idf : idf * (x0.startsWith(CARRY_Q) ? CARRY_W : CARRY_W2);
      }
      return { rec: c.rec, n: n + proxBonus(hay, c.rec.text) + titleBonus(text, c.rec.text) + favBonus(text, c.rec.text) + speakerBonus(text, c.rec.text, speakers) + quantBonus(text, c.rec.text) + howBonus(text, c.rec.text) + intentBonus(text, c.rec.text) + whereBonus(text, c.rec.text) + (c.rec.kind === "digest" ? DIGEST_BONUS : 0) };
    }).filter((x) => x.n).sort((a, b) => b.n - a.n || Number(b.rec.kind === "constraint") - Number(a.rec.kind === "constraint") || b.rec.at - a.rec.at).slice(0, Math.max(cap * 6, 30, fuse ? 120 : 0));
    return dedupSelect(fuse ? fuseIfCrowded(scored, hay, speakers, cap) : scored, cap);
  }

  notesFor(text = "", k = Number(process.env.EDEN_MEMORY_CAP) || 6, opts: { fuse?: boolean } = {}): MemoryRecord[] {
    const map = (recs: MemoryRecord[]) => recs.map((r) => ({ ...r, text: retrieveText(r.text) }));
    if (text) return map(this.relevant(text, k, opts.fuse !== false));
    return map(((recs) => [...recs.filter((r) => r.kind === "constraint").slice(-k), ...recs.filter((r) => r.kind !== "constraint").slice(-k)].filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i).slice(0, k))(this.memories()));
  }

  query(q: string, k = Number(process.env.EDEN_MEMORY_CAP) || 6): QueryHit[] {
    const qn = q.trim(), out: QueryHit[] = qn ? this.notesFor(qn, k).map((m) => ({ text: m.text, source: "memory" as const, id: m.id })) : [];
    if (qn && out.length < k) try { const card = knowQuery(qn, this.know); if (card && "fact" in card && card.fact) out.push({ text: card.fact, source: "know", url: card.url }); } catch {}
    return out.slice(0, k);
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
  close() {}
}

export function openMemory(opts: MemoryOptions = {}): AgentMemory {
  return new AgentMemory(opts);
}

let proc: AgentMemory | undefined;
export function processMemory(): AgentMemory {
  return process.argv.some((a) => a.endsWith(".test.ts")) ? openMemory({ dir: join(tmpdir(), "eden-m-" + Math.random().toString(36).slice(2)) }) : (proc ??= openMemory({ dir: process.env.EDEN_MEMORY_DIR || (process.env.EDEN_HOME ? join(process.env.EDEN_HOME, "memory") : undefined), agent: process.env.EDEN_MEMORY_AGENT || undefined, project: process.env.EDEN_MEMORY_PROJECT || undefined }));
}

export function host(opts: MemoryOptions & { port?: number } = {}) {
  const memory = openMemory(opts);
  const server = Bun.serve({
    hostname: process.env.EDEN_MEMORY_HOST || "127.0.0.1",
    port: Number(opts.port ?? process.env.EDEN_MEMORY_PORT) || 8787,
    async fetch(req) {
      const origin = req.headers.get("origin") || "";
      const cors = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin) ? { "access-control-allow-origin": origin, vary: "origin", "access-control-expose-headers": "content-type" } : {};
      const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
      try {
        if (req.method === "HEAD") return new Response(null, { status: 200, headers: cors });
        if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "content-type, authorization", "access-control-max-age": "86400" } });
        const u = new URL(req.url);
        const p = u.pathname.replace(/\/+$/, "").replace(/^\/v1(?=\/)/, "") || "/";
        if (req.method === "DELETE") return json({ ok: memory.forget(String(u.searchParams.get("id") || u.searchParams.get("q") || p.split("/").pop() || "")) });
        if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
          const b = (await req.json().catch(() => ({}))) as { text?: string; prompt?: string; input?: string; content?: string; query?: string; message?: string; body?: string; system?: string; systemInstruction?: unknown; system_instruction?: unknown; id?: string; messages?: unknown[]; conversation?: unknown[]; contents?: unknown[]; q?: string; k?: number };
          const sys = b.systemInstruction ?? b.system_instruction, blob = String(b.text || b.prompt || b.input || b.content || b.query || b.message || b.body || b.system || (typeof sys === "string" ? sys : "") || ""), msgs = b.messages || b.conversation || b.contents || (blob ? [{ role: "user", content: blob }] : sys && typeof sys !== "string" ? [sys] : []);
          const run = ({ "/observe": () => memory.observe(msgs), "/remember": () => memory.remember(blob, b), "/forget": () => ({ ok: memory.forget(String(b.id || blob)) }), "/inject": () => { const n = memory.inject(msgs); return Array.isArray(b.contents) && !b.messages ? { contents: n, messages: n } : { messages: n }; }, "/query": () => memory.query(String(b.q || blob), Number(b.k) || Number(process.env.EDEN_MEMORY_CAP) || 6) } as Record<string, () => unknown>)[p]; if (run) return json(run());
        } else {
          const q = u.searchParams.get("q") || u.searchParams.get("text") || u.searchParams.get("prompt") || u.searchParams.get("input") || u.searchParams.get("content") || u.searchParams.get("message") || u.searchParams.get("system") || u.searchParams.get("body") || u.searchParams.get("system_prompt") || "", k = Number(u.searchParams.get("k")) || Number(process.env.EDEN_MEMORY_CAP) || 6, health = () => ({ ok: true, n: memory.memories().length });
          const run = ({ "/": health, "/health": health, "/query": () => memory.query(q, k), "/observe": () => memory.observe(q ? [{ role: "user", content: q }] : []), "/remember": () => memory.remember(q), "/forget": () => ({ ok: memory.forget(String(u.searchParams.get("id") || q)) }), "/inject": () => { const n = memory.inject(q ? [{ role: "user", content: q }] : []); return { messages: n, contents: n }; }, "/memories": () => (q ? memory.query(q, k) : memory.memories().slice().sort((a, b) => b.at - a.at).slice(0, Number(u.searchParams.get("limit") || u.searchParams.get("k")) || 500)) } as Record<string, () => unknown>)[p]; if (run) return json(run());
        }
        return new Response("eden memory\n", { headers: cors });
      } catch (e) { return json({ error: String(e) }, 400); }
    },
  });
  return { url: String(server.url), stop: () => server.stop(), memory };
}
