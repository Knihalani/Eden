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
const QUERY_SKIP = new Set(["recently","today","yesterday","currently","recent","now","also","really","kind","type","plans","favorite","thing","things","stuff","did","does","make","made","doing","having"]);

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
    else if (t.endsWith("?") || !(/\b(prefer(?:s|red)?|never |always |must |from now on|note that|don'?t |ran out|i want |fyi|also,|we should |make sure |stands for| aka |called |confirmed |decided |settled on|going with|agreed to|switched to|standardized on|standardized to|rolled back|pinned to|migrated to|reverted to|deprecated |cut over to|turned on|turned off|enabled the|disabled the|shipped |assigned |owned by|belongs to|due on|due by|deadline|blocked on|depends on|required |lives in|live in|stays in|stay in|moved to|based in|located |works (?:at|for)|work (?:on|at|for)|skip dairy|vegetarian|named |our dog|my dog|reports to|on-call|\bci\b|runs on|pagerduty|slack |cluster |namespace |region |vpc |timezone|branch |repo |org |team |channel |workspace |project |sprint |ticket |issue |hotfix |incident |sev[0-3]|p[0-3] |outage |pager |rollback |deployed |feature flag|kill switch|launchdarkly|maintenance |degraded |slo |sla |quota |budget |capacity |limit |rate.?limit|retr(?:y|ies|ied)|backoff|dri |owner |circuit.?breaker|webhook|endpoint|crontab|cronjob|version |k8s |kubernetes|configmap|helm |terraform|pulumi|cloudformation|iam |cdk |ansible|gcp |gcloud |azure |snowflake|bigquery|datadog|kafka|redshift|pubsub|rabbitmq|redis|postgres|elasticsearch|mongodb|mysql|dynamodb|sentry|grafana|prometheus|newrelic|honeycomb|otel|opentelemetry|jaeger|zipkin|cloudwatch|splunk|lambda|sqs|sns|cloudtrail|kinesis|ecs|step.?functions?|eks|fargate|rds|aurora|secrets.?manager|cloudfront|elasticache|alb|route.?53|api.?gateway|waf|ecr|nlb|elb|s3|kms|athena|glue|cognito|ebs|emr|sagemaker|bedrock|aws.?batch|eventbridge|codebuild|codepipeline|codedeploy|appconfig|amplify|appsync|xray|codecommit|codeartifact|efs|fsx|databricks|clickhouse|prestodb|trino|duckdb|flink|cassandra|neo4j|scylla|cockroach|vitess|tidb|spanner|cosmosdb|firestore|bigtable|memcached|consul|etcd|zookeeper|vault|nomad|istio|envoy|linkerd|traefik|kong|cilium|argocd|fluxcd|knative|calico|tekton|crossplane|kustomize|harbor|helmfile|thanos|mimir|cortex|fluentbit|fluentd|filebeat|logstash|opensearch|metricbeat|qdrant|weaviate|milvus|pinecone|typesense|meilisearch|pgvector|faiss|lancedb|chromadb|solr|nats|pulsar|mosquitto|emqx|airflow|dagster|prefect|temporal|flyte|kubeflow|mlflow|feast|wandb|dvc|huggingface|langsmith|llamaindex|ollama|vllm|sglang|tgi|tensorrt|triton|ggml|gguf|llamafile|exllamav2|awq|gptq|bitsandbytes|flashattn|deepspeed|fsdp|megatron|horovod|nccl|accelerate|xla|ship from|ships from)\b/i.test(t) || (/\b(is|are|was|were|needs?|uses?|will be|ha(?:s|ve) been)\b/i.test(t) && /[A-Z][a-zA-Z]|:\/\/|\w+\.\w+|\d{2,}/.test(t)) || /^[A-Z][A-Za-z0-9 /._-]{1,32}:\s+\S/.test(t) || /^\d+[.)]\s+.{8,}/.test(t) || /^[-*]\s+.{8,}/.test(t) || /"[^"]{4,80}"\s+(?:is|means|aka)/i.test(t) || /@[\w.-]+\.[a-z]{2,}/i.test(t) || /\b20\d{2}-\d{2}-\d{2}\b/.test(t) || /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(t) || /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(t) || /\$\d{2,}/.test(t) || /(?:~\/|\/(?:Users|home|opt|usr|var|etc)\/)[\w./-]+/.test(t) || /\b[A-Z][A-Z0-9_]{2,}=\S/.test(t) || /\bport\s+\d{2,5}\b/i.test(t) || /\b[\w.-]+\.(?:json|ya?ml|toml|env)\b/.test(t) || /\b[\w-]+\.(?:com|io|dev|internal|local)\b/.test(t) || /\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\b/.test(t) || /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/.test(t) || /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(t) || /\b[0-9a-f]{40}\b/.test(t) || /\b(?:\*|\d{1,2})(?:\s+(?:\*|\d{1,2})){4}\b/.test(t) || /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i.test(t) || /\bv\d+\.\d+\.\d+\b/i.test(t) || /\b[\w-]+\.[\w-]+\.svc(?:\.cluster\.local)?\b/.test(t) || /\barn:aws:[a-z0-9-]+:/i.test(t))) continue;
    t = t.replace(/^[.\s]+|[.\s]+$/g, "");
    if (SPEAKER_LABEL.test(t)) {
      const sp = new Set(tokList((t.match(SPEAKER_LABEL)?.[1] || "").replace(/:$/, "")));
      if (!tokList(t).some((w) => !sp.has(w) && (w.length >= 5 || /^\d/.test(w)) && !STOP.has(w))) continue;
    }
    if (t.length >= 8 && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out;
}

function compile(rec: MemoryRecord): Compiled {
  return { rec, needles: [...new Set([...rec.tags, ...tokList(rec.text).filter((w) => w.length >= 3 && !STOP.has(w))])] };
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
    for (const text of extractDurable(blob)) {
      if (this.compiled.some((c) => (!this.project || c.rec.project === this.project) && c.rec.text.toLowerCase() === text.toLowerCase())) continue;
      const key = subjectKey(text);
      if (key) this.compiled = this.compiled.filter((c) => (this.project && c.rec.project !== this.project) || subjectKey(c.rec.text) !== key);
      out.push(this.remember(text, { kind: /\b(prefer|never |always |don'?t |must |from now on)\b/i.test(text) ? "constraint" : /\b(ran out|shipped |decided |settled on|going with|agreed to|switched to|standardized on|standardized to|rolled back|pinned to|migrated to|reverted to|deprecated |cut over to|turned on|turned off|enabled the|disabled the)\b/i.test(text) ? "episode" : "fact", tags: tokList(text).concat(([[/\bpull requests?\b/i, "pr"], [/\btimezone|pacific|utc\b/i, "tz"], [/@[\w.-]+\.[a-z]{2,}/i, "email"], [/\b(vegetarian|vegan|pescatarian|skip dairy|lactose|allerg|kosher|halal|gluten)\b/i, "diet"]] as const).flatMap(([re, t]) => re.test(text) ? [t] : [])) }));
    }
    return out;
  }

  private persist() {
    if (this.compiled.length > 2000) { const keep = this.compiled.filter((c) => c.rec.kind === "constraint").sort((a, b) => a.rec.at - b.rec.at).slice(-2000); const rest = this.compiled.filter((c) => c.rec.kind !== "constraint").sort((a, b) => a.rec.at - b.rec.at); this.compiled = [...keep, ...rest.slice(Math.max(0, rest.length - (2000 - keep.length)))]; } writeFileSync(this.path, this.compiled.map((x) => JSON.stringify(x.rec)).join("\n") + (this.compiled.length ? "\n" : ""), { mode: 0o600 });
  }

  relevant(text: string, cap = Number(process.env.EDEN_MEMORY_CAP) || 6): MemoryRecord[] {
    const hay = queryHay(text);
    const hayStem = new Set([...hay].map(liteStem));
    const rows = this.compiled.filter((c) => !(this.agent && c.rec.agent && c.rec.agent !== this.agent) && !(this.project && c.rec.project !== this.project));
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
    for (const c of rows) {
      const seen = new Set<string>();
      for (const x of c.needles) if (hit(x) && !seen.has(x)) { seen.add(x); df.set(x, (df.get(x) || 0) + 1); }
    }
    return rows.map((c) => {
      let n = 0;
      const seen = new Set<string>();
      for (const x of c.needles) {
        if (!hit(x) || seen.has(x)) continue;
        seen.add(x);
        const d = df.get(x) || 0;
        let idf = Math.log((N - d + 0.5) / (d + 0.5) + 1);
        if (d / N < 0.04) idf *= 1.55;
        n += idf;
      }
      return { rec: c.rec, n: n + proxBonus(hay, c.rec.text) + titleBonus(text, c.rec.text) + favBonus(text, c.rec.text) + speakerBonus(text, c.rec.text, speakers) + quantBonus(text, c.rec.text) + howBonus(text, c.rec.text) + intentBonus(text, c.rec.text) + whereBonus(text, c.rec.text) };
    }).filter((x) => x.n).sort((a, b) => b.n - a.n || Number(b.rec.kind === "constraint") - Number(a.rec.kind === "constraint") || b.rec.at - a.rec.at).slice(0, cap).map((x) => x.rec);
  }

  notesFor(text = "", k = Number(process.env.EDEN_MEMORY_CAP) || 6): MemoryRecord[] {
    const map = (recs: MemoryRecord[]) => recs.map((r) => ({ ...r, text: retrieveText(r.text) }));
    if (text) return map(this.relevant(text, k));
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
