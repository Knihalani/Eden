import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
type Note = { role: "system"; content: string };

const STOP = new Set(["the","of","is","a","an","on","to","and","in","for","this","that","with","from","into","about","these","then","still","has","out","please","how","should","what","why","was","are","you","your","its","our","not","never","use","used","just","last","week","down","look","next","need","before","merge","prefers","user","memory","ran","fact","such","or","no","app"]);

function tokList(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [];
}

function convBlob(list: unknown[]): string {
  if (list.length === 1) {
    const o = list[0] as Record<string, unknown> | undefined;
    if (o && typeof o.content === "string" && !(o.reasoning_content || o.thinking || o.reasoning)) return o.content;
  }
  const parts: string[] = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    const c = o.content;
    if (typeof c === "string") {
      if (c) parts.push(c);
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b && typeof b === "object") {
          const x = b as Record<string, unknown>;
          const t = ["text","content","alt","name","caption","title","filename","url","href","source","uri","id","mimeType"].map((k) => x[k]).find((v) => typeof v === "string" && v);
          if (t) parts.push(t as string);
        }
      }
    }
    const r = o.reasoning_content ?? o.thinking ?? o.reasoning;
    if (typeof r === "string" && r) parts.push(r);
  }
  return parts.join("\n");
}

const CHAT = /^(ok|okay|thanks|thank you|got it|sure|yeah|yep|please\b|hmm|wait|anyway|nah|hey|yo|lol|haha|lmao|nope|np|wow|whoa|idk|dunno|alright|gotcha|sounds good|lgtm|ack|cheers|ty|gg|brb|nvm|omg|kk|yup|thx|ttyl|smh|wfm|idc|ngl|fr|ikr|meh|ugh|welp|yikes|oops|huh)\b/i;

function extractDurable(blob: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of blob.split(/(?<=[.!\n;])\s+/)) {
    let t = raw.trim().replace(/\s+/g, " ").replace(/^(i think|i believe|i guess|maybe|perhaps|tbh|imo|btw,|fwiw,)\s+/i, "");
    if (t.length < 8 || t.length > 400 || t.startsWith("{") || t.startsWith("[") || t.startsWith("```") || t.startsWith("http") || t.startsWith("#") || /^(const|let|import |export |function |npm |pnpm |bun |git |cd |curl |yarn |npx |sudo |echo |cat |ls )\b/.test(t) || t.includes(MEMORY_MARK) || t.includes("Eden Know:") || /\bleftover intern firm\b/i.test(t) || /^(thinking about|you are|we are|this is|it is|that is|there (is|are)|i am going|i want to|this means|let me|i'll|let's|i'm|we will|look at|can you|could you|would you|tell me|fix the|add the|we need to|we're|cool, |nice, |great, |awesome, |perfect, )\b/i.test(t) || /\b(?:sk-|ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9]/.test(t) || CHAT.test(t)) continue;
    const rem = t.match(/\bremember(?: that)?\s+(.+)/i);
    if (rem) t = rem[1].trim();
    else if (t.endsWith("?") || !(/\b(prefer(?:s|red)?|never |always |must |from now on|note that|don'?t |ran out|i want |fyi|also,|we should |make sure |stands for| aka |called |confirmed |decided |shipped |assigned |owned by|belongs to|due on|due by|deadline|blocked on|depends on|required |lives in|based in|located |works (?:at|for)|reports to|on-call|pagerduty|slack |cluster |namespace |region |vpc |timezone|branch |repo |org |team |channel |workspace |project |sprint |ticket |issue |hotfix |incident |sev[0-3]|p[0-3] |outage |pager |rollback |deployed |feature flag|kill switch|launchdarkly|maintenance |degraded |slo |sla |quota |budget |capacity |limit |rate.?limit|retr(?:y|ies|ied)|backoff|dri |owner |circuit.?breaker|webhook|endpoint|crontab|cronjob|version |k8s |kubernetes|configmap|helm |terraform|pulumi|cloudformation|iam |cdk |ansible|gcp |gcloud |azure |snowflake|bigquery|datadog|kafka|redshift|pubsub|rabbitmq|redis|postgres|elasticsearch|mongodb|mysql|dynamodb|sentry|grafana|prometheus|newrelic|honeycomb|otel|opentelemetry|jaeger|zipkin|cloudwatch|splunk|lambda|sqs|sns|cloudtrail|kinesis|ecs|step.?functions?|eks|fargate|rds|aurora|secrets.?manager|cloudfront|elasticache|alb|route.?53|api.?gateway|waf|ecr|nlb|elb|s3|kms|athena|glue|cognito|ebs|emr|sagemaker|bedrock|aws.?batch|eventbridge|codebuild|codepipeline|codedeploy|appconfig|amplify|appsync|xray|codecommit|codeartifact|efs|fsx|databricks|clickhouse|prestodb|trino|duckdb|flink|cassandra|neo4j|scylla|cockroach|vitess|tidb|spanner|cosmosdb|firestore|bigtable|memcached|consul|etcd|zookeeper|vault|nomad|istio|envoy|linkerd|traefik|kong|cilium|argocd|fluxcd|knative|calico|tekton|crossplane|kustomize|harbor|helmfile|thanos|mimir|cortex|fluentbit|fluentd|filebeat|logstash|opensearch|metricbeat|qdrant|weaviate|milvus|pinecone|typesense|meilisearch|pgvector|faiss|lancedb|chromadb|solr|nats|pulsar|mosquitto|emqx|airflow|dagster|prefect|temporal|flyte|kubeflow|mlflow|feast|wandb|dvc|huggingface|langsmith|llamaindex|ollama|vllm|sglang|tgi|tensorrt|triton|ggml|gguf|llamafile|exllamav2|awq|gptq|bitsandbytes|flashattn|deepspeed|fsdp|megatron|horovod|nccl|accelerate|xla)\b/i.test(t) || (/\b(is|are|was|were|needs?|uses?|will be|ha(?:s|ve) been)\b/i.test(t) && /[A-Z][a-zA-Z]|:\/\/|\w+\.\w+|\d{2,}/.test(t)) || /^[A-Z][A-Za-z0-9 /._-]{1,32}:\s+\S/.test(t) || /^\d+[.)]\s+.{8,}/.test(t) || /^[-*]\s+.{8,}/.test(t) || /"[^"]{4,80}"\s+(?:is|means|aka)/i.test(t) || /@[\w.-]+\.[a-z]{2,}/i.test(t) || /\b20\d{2}-\d{2}-\d{2}\b/.test(t) || /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(t) || /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(t) || /\$\d{2,}/.test(t) || /(?:~\/|\/(?:Users|home|opt|usr|var|etc)\/)[\w./-]+/.test(t) || /\b[A-Z][A-Z0-9_]{2,}=\S/.test(t) || /\bport\s+\d{2,5}\b/i.test(t) || /\b[\w.-]+\.(?:json|ya?ml|toml|env)\b/.test(t) || /\b[\w-]+\.(?:com|io|dev|internal|local)\b/.test(t) || /\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\b/.test(t) || /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/.test(t) || /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(t) || /\b[0-9a-f]{40}\b/.test(t) || /\b(?:\*|\d{1,2})(?:\s+(?:\*|\d{1,2})){4}\b/.test(t) || /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i.test(t) || /\bv\d+\.\d+\.\d+\b/i.test(t) || /\b[\w-]+\.[\w-]+\.svc(?:\.cluster\.local)?\b/.test(t) || /\barn:aws:[a-z0-9-]+:/i.test(t))) continue;
    t = t.replace(/^[.\s]+|[.\s]+$/g, "");
    const k = t.toLowerCase();
    if (t.length >= 8 && !seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

function compile(rec: MemoryRecord): Compiled {
  const needles = [...new Set([...rec.tags.map((t) => t.toLowerCase()), ...tokList(rec.text).filter((w) => w.length >= 4 && !STOP.has(w))])];
  return { rec, needles };
}

function load(path: string): Compiled[] {
  if (!existsSync(path)) return [];
  const out: Compiled[] = [];
  for (const t of readFileSync(path, "utf8").split("\n")) {
    try {
      const rec = JSON.parse(t) as MemoryRecord;
      if (rec?.id && rec.text) out.push(compile(rec));
    } catch {}
  }
  return out;
}

function subjectKey(text: string): string | null {
  const k = text.trim().match(/^(.{4,80}?)\s+(?:is|are|was|were)\s+\S/i)?.[1]?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "";
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
    this.dir = opts.dir || join(homedir(), ".eden", "memory");
    this.know = opts.know;
    this.agent = opts.agent;
    this.project = opts.project;
    mkdirSync(this.dir, { recursive: true });
    this.path = join(this.dir, "memories.jsonl");
    this.compiled = load(this.path);
  }

  memories(): MemoryRecord[] {
    return this.compiled.map((c) => c.rec).filter((r) => !this.project || r.project === this.project);
  }

  remember(text: string, opts: { kind?: MemoryKind; tags?: string[]; id?: string; agent?: string; project?: string } = {}): MemoryRecord {
    const rec: MemoryRecord = { id: opts.id || `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, text: String(text || "").trim(), kind: opts.kind || "fact", tags: (opts.tags || []).map((t) => t.toLowerCase()), agent: opts.agent || this.agent, project: opts.project || this.project, at: Date.now() };
    if (!rec.text) return rec;
    const c = compile(rec);
    const i = this.compiled.findIndex((x) => x.rec.id === rec.id);
    if (i >= 0) this.compiled[i] = c;
    else this.compiled.push(c);
    this.persist();
    return rec;
  }

  forget(id: string): boolean {
    const n = this.compiled.length;
    this.compiled = this.compiled.filter((c) => c.rec.id !== id && c.rec.text !== id);
    if (this.compiled.length === n) return false;
    this.persist();
    return true;
  }

  observe(messages: unknown[]): MemoryRecord[] {
    const list = (Array.isArray(messages) ? messages : []).filter((m) => (m && typeof m === "object" ? (m as { role?: string }).role : "") !== "system");
    const blob = convBlob(list);
    const out: MemoryRecord[] = [];
    for (const text of extractDurable(blob)) {
      if (this.compiled.some((c) => (!this.project || c.rec.project === this.project) && c.rec.text.toLowerCase() === text.toLowerCase())) continue;
      const key = subjectKey(text);
      if (key) this.compiled = this.compiled.filter((c) => (this.project && c.rec.project !== this.project) || subjectKey(c.rec.text) !== key);
      const tags = tokList(text);
      if (/\bpull requests?\b/i.test(text)) tags.push("pr");
      if (/\btimezone|pacific|utc\b/i.test(text)) tags.push("tz");
      if (/@[\w.-]+\.[a-z]{2,}/i.test(text)) tags.push("email");
      out.push(this.remember(text, { kind: /\b(prefer|never |always |don'?t |must |from now on)\b/i.test(text) ? "constraint" : /\b(ran out|shipped |decided )\b/i.test(text) ? "episode" : "fact", tags }));
    }
    return out;
  }

  private persist() {
    writeFileSync(this.path, this.compiled.map((x) => JSON.stringify(x.rec)).join("\n") + (this.compiled.length ? "\n" : ""));
  }

  relevant(text: string, cap = 6): MemoryRecord[] {
    const hay = new Set(tokList(text));
    const hit = this.compiled.filter((c) => !(this.agent && c.rec.agent && c.rec.agent !== this.agent) && !(this.project && c.rec.project !== this.project) && c.needles.some((n) => hay.has(n))).map((c) => c.rec);
    hit.sort((a, b) => Number(b.kind === "constraint") - Number(a.kind === "constraint") || b.at - a.at);
    return hit.slice(0, cap);
  }

  query(q: string, k = 5): QueryHit[] {
    const qn = q.trim();
    const out: QueryHit[] = qn ? this.relevant(qn, k).map((m) => ({ text: m.text, source: "memory" as const, id: m.id })) : [];
    try {
      const card = knowQuery(qn, this.know);
      if (card && "fact" in card && card.fact) out.push({ text: card.fact, source: "know", url: card.url });
    } catch {}
    return out.slice(0, k);
  }

  inject(messages: unknown[]): unknown[] {
    const list = Array.isArray(messages) ? messages : [];
    try {
      const blob = convBlob(list);
      const notes: Note[] = [];
      if (!alreadyInjected(blob) && !blob.includes(MEMORY_MARK)) {
        const mems = this.relevant(blob);
        if (mems.length) notes.push({ role: "system", content: MEMORY_MARK + mems.map((m) => `\n- ${m.text}`).join("") });
        const card = injectFromRequest({ text: blob }, this.know);
        if (card) notes.push({ role: "system", content: injectNote(card) });
      }
      const next = notes.length ? list.slice() : list;
      if (notes.length) {
        let i = 0;
        while (i < next.length && (next[i] as { role?: string })?.role === "system") i++;
        next.splice(i, 0, ...notes);
      }
      this.observe(list);
      return next;
    } catch {
      return list;
    }
  }

  injectBody(body: Record<string, unknown>): Record<string, unknown> {
    const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
    const next = this.inject(messages);
    return next === messages ? body : { ...body, messages: next };
  }
  close() {}
}

export function openMemory(opts: MemoryOptions = {}): AgentMemory {
  return new AgentMemory(opts);
}

let proc: AgentMemory | undefined;
export function processMemory(): AgentMemory {
  if (process.argv.some((a) => a.endsWith(".test.ts"))) return openMemory({ dir: join(tmpdir(), "eden-m-" + Math.random().toString(36).slice(2)) });
  return (proc ??= openMemory({ dir: process.env.EDEN_MEMORY_DIR || undefined }));
}

export function host(opts: MemoryOptions & { port?: number } = {}) {
  const memory = openMemory(opts);
  const port = Number(opts.port ?? process.env.EDEN_MEMORY_PORT) || 8787;
  const server = Bun.serve({
    port: port > 0 ? port : 8787,
    async fetch(req) {
      try {
        const u = new URL(req.url);
        const p = u.pathname;
        if (req.method === "POST") {
          const b = (await req.json()) as { text?: string; id?: string; messages?: unknown[]; q?: string; k?: number };
          const run = ({ "/observe": () => memory.observe(b.messages || []), "/remember": () => memory.remember(String(b.text || ""), b), "/forget": () => ({ ok: memory.forget(String(b.id || b.text || "")) }), "/inject": () => ({ messages: memory.inject(b.messages || []) }), "/query": () => memory.query(String(b.q || ""), Number(b.k) || 5) } as Record<string, () => unknown>)[p];
          if (run) return Response.json(run());
        } else {
          const run = ({ "/health": () => ({ ok: true }), "/query": () => memory.query(u.searchParams.get("q") || "", Number(u.searchParams.get("k")) || 5), "/memories": () => memory.memories() } as Record<string, () => unknown>)[p];
          if (run) return Response.json(run());
        }
        return new Response("eden memory\n");
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 400 });
      }
    },
  });
  return { url: String(server.url), stop: () => { memory.close(); server.stop(); }, memory };
}
