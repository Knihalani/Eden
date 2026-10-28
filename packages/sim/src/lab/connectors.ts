/**
 * The lab's connectors: an open-source MCP server (built by build.ts from a pinned commit) and the backend it reads,
 * seeded with a world. Servers run as `docker run -i` over stdio with no network, or only the internal `lab-net`
 * network where their backend lives: they never see the internet or any secret.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { World, WorldItem } from "../world";
import { worldKey, type LabConnector } from "./lab";

const NET = "lab-net";
/** On every lab container, so a run can remove what it leaves behind. */
const LABEL = "eden-lab=1";

function docker(args: string[]): string {
  const p = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`docker ${args.slice(0, 2).join(" ")}: ${p.stderr.toString().slice(0, 500)}`);
  return p.stdout.toString().trim();
}

/** The internal network backends and servers share; it has no route out. */
export function ensureNetwork(): void {
  const nets = docker(["network", "ls", "--format", "{{.Name}}"]).split("\n");
  if (!nets.includes(NET)) docker(["network", "create", "--internal", NET]);
  // A network of that name made by someone else may have a route out; the lab's isolation depends on it not.
  if (docker(["network", "inspect", "-f", "{{.Internal}}", NET]) !== "true") {
    throw new Error(`docker network ${NET} exists but is not --internal; remove it and rerun`);
  }
}

/** Removes every lab container still running (a server that ignored the end of its input, a killed run). */
export function removeLabContainers(): void {
  const ids = docker(["ps", "-aq", "--filter", `label=${LABEL}`])
    .split("\n")
    .filter(Boolean);
  if (!ids.length) return;
  try {
    docker(["rm", "-f", ...ids]);
  } catch (e) {
    // A container already being removed (a `--rm` server exiting) or already gone is what this wanted.
    if (!/already in progress|No such container/.test(String(e))) throw e;
  }
}

/** Starts a backend container on the lab network and returns its address (reachable from this host). */
function backend(name: string, image: string, args: string[] = []): string {
  Bun.spawnSync(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
  docker(["run", "-d", "--name", name, "--label", LABEL, "--network", NET, ...args, image]);
  return docker(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name]);
}

const removeContainer = (name: string) =>
  Bun.spawnSync(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });

/** A stdio transport to a lab server image; `network` is "none" unless it must reach a backend. */
function stdio(image: string, opts: { network?: string; mounts?: string[]; env?: Record<string, string> } = {}) {
  const args = ["run", "-i", "--rm", "--label", LABEL, "--network", opts.network ?? "none"];
  for (const m of opts.mounts ?? []) args.push("-v", m);
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
  // The Docker CLI gets only what locates the daemon; the container gets only the -e values above, so no key or token
  // from this process's environment reaches a server.
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return new StdioClientTransport({ command: "docker", args: [...args, image], env });
}

/** Plain HTTP to a lab backend, bypassing any HTTPS proxy (the backend is on a local bridge). */
async function http(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, proxy: undefined } as RequestInit);
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const tempDir = (name: string) => mkdtempSync(join(tmpdir(), `lab-${name}-`));

const all = () => true;

/** The reference knowledge-graph memory server: one entity per item, its lines as observations. */
export function memory(): LabConnector {
  let dir = "";
  return {
    name: "memory",
    semantics: "whole query as one case-insensitive substring of an entity's name, type or one observation",
    accepts: all,
    async setup(items) {
      dir = tempDir("memory");
      const lines = items.map((i) =>
        JSON.stringify({
          type: "entity",
          // Names must be unique (the server merges by name); the key also maps results back to the world.
          name: `${i.title} [${worldKey(i)}]`,
          entityType: i.kind,
          observations: i.text.split("\n").filter((l) => l.trim()),
        }),
      );
      writeFileSync(join(dir, "memory.jsonl"), lines.join("\n") + "\n");
    },
    transport: () => stdio("lab/memory", { mounts: [`${dir}:/data:ro`] }),
    searchTool: { name: "search_nodes", args: (text) => ({ query: text }) },
    async teardown() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function markdownVault(items: WorldItem[], dir: string, frontmatter: boolean): void {
  for (const i of items) {
    mkdirSync(join(dir, i.sourceId), { recursive: true });
    const head = frontmatter ? `---\ntitle: ${JSON.stringify(i.title)}\ntype: ${i.kind}\n---\n\n` : "";
    writeFileSync(join(dir, i.sourceId, `${worldKey(i)}.md`), `${head}# ${i.title}\n\n${i.text}\n`);
  }
}

/** mcpvault over an Obsidian-style vault: one note per item. */
export function mcpvault(): LabConnector {
  let dir = "";
  return {
    name: "mcpvault",
    semantics: "any query term as a substring (OR), then a BM25-style rerank; also matches file names",
    accepts: all,
    async setup(items) {
      dir = tempDir("vault");
      markdownVault(items, dir, false);
    },
    transport: () => stdio("lab/mcpvault", { mounts: [`${dir}:/vault:ro`] }),
    searchTool: { name: "search_notes", args: (text, limit) => ({ query: text, limit: Math.min(limit, 20) }) },
    // search_notes carries no annotations; it only reads files, checked in its source (src/search.ts), and the
    // server runs with --read-only.
    trustedReadTools: ["search_notes"],
    async teardown() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Basic Memory over a folder of notes, indexed into SQLite FTS5 before the server starts. */
export function basicMemory(): LabConnector {
  let dir = "";
  return {
    name: "basic-memory",
    semantics: "SQLite FTS5: every term as a prefix, AND; OR-relaxed retry when nothing matches; text mode",
    accepts: all,
    async setup(items) {
      dir = tempDir("basic-memory");
      mkdirSync(join(dir, "basic-memory"), { recursive: true });
      markdownVault(items, join(dir, "basic-memory"), true);
      const p = Bun.spawnSync(
        ["docker", "run", "--rm", "--network", "none", "-v", `${dir}:/state`, "--entrypoint", "basic-memory"].concat([
          "lab/basic-memory",
          "reindex",
          "--search",
          "--full",
        ]),
        { stdout: "pipe", stderr: "pipe" },
      );
      if (p.exitCode !== 0) throw new Error(`basic-memory reindex: ${p.stderr.toString().slice(-500)}`);
    },
    transport: () => stdio("lab/basic-memory", { mounts: [`${dir}:/state`] }),
    searchTool: {
      name: "bm_search",
      args: (text, limit) => ({ query: text, mode: "text", page_size: limit, output_format: "json" }),
    },
    async teardown() {
      // Files the container wrote are root-owned; the container removes them.
      Bun.spawnSync(
        ["docker", "run", "--rm", "-v", `${dir}:/state`, "--entrypoint", "rm", "lab/basic-memory"].concat([
          "-rf",
          "/state/basic-memory",
          "/state/.basic-memory",
        ]),
      );
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const MEILI_KEY = "lab-master-key-0123456789";

/** The official Meilisearch MCP server over the official Meilisearch image: one document per item. */
export function meilisearch(): LabConnector {
  return {
    name: "meilisearch",
    semantics: "ranked, typo-tolerant full text (Meilisearch defaults); missing terms lower the rank, not exclude",
    accepts: all,
    async setup(items) {
      const ip = backend("lab-meili", "mirror.gcr.io/getmeili/meilisearch:v1.12", [
        "-e",
        `MEILI_MASTER_KEY=${MEILI_KEY}`,
        "-e",
        "MEILI_NO_ANALYTICS=true",
      ]);
      const base = `http://${ip}:7700`;
      const auth = { Authorization: `Bearer ${MEILI_KEY}`, "Content-Type": "application/json" };
      await waitFor(async () => (await http(`${base}/health`)).ok, "meilisearch");
      const docs = items.map((i) => ({ id: worldKey(i), title: i.title, text: i.text, kind: i.kind }));
      const res = await http(`${base}/indexes/items/documents?primaryKey=id`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(docs),
      });
      if (!res.ok) throw new Error(`meilisearch documents ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const { taskUid } = (await res.json()) as { taskUid: number };
      await waitFor(async () => {
        const t = (await (await http(`${base}/tasks/${taskUid}`, { headers: auth })).json()) as { status: string };
        if (t.status === "failed") throw new Error("meilisearch indexing failed");
        return t.status === "succeeded";
      }, "meilisearch indexing");
    },
    transport: () =>
      stdio("lab/meilisearch", {
        network: NET,
        env: { MEILI_HTTP_ADDR: "http://lab-meili:7700", MEILI_MASTER_KEY: MEILI_KEY },
      }),
    searchTool: { name: "search", args: (text, limit) => ({ query: text, indexUid: "items", limit }) },
    async teardown() {
      removeContainer("lab-meili");
    },
  };
}

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/** The event's start and end from its "When:" line (`Thursday 29 Oct 2026, 19:30–21:00`), else its update time. */
export function eventTimes(item: WorldItem): { start: Date; end: Date } {
  const m = /When: \w+ (\d{1,2}) (\w{3}) (\d{4})(?:, (\d{1,2}):(\d{2})(?:[–-](\d{1,2}):(\d{2}))?)?/.exec(item.text);
  if (!m) return { start: new Date(item.updatedAt), end: new Date(item.updatedAt + 3_600_000) };
  const month = MONTHS.indexOf(m[2]!);
  const start = new Date(Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4] ?? 9), Number(m[5] ?? 0)));
  const end = m[6]
    ? new Date(Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[6]), Number(m[7])))
    : new Date(start.getTime() + 3_600_000);
  return { start, end };
}

const ics = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

/** A CalDAV MCP server over Radicale: the world's events, written as iCalendar objects. */
export function caldav(): LabConnector {
  let window = { start: "", end: "" };
  return {
    name: "caldav",
    semantics: "whole query as one substring of title, description, location or an attendee; a date window is required",
    accepts: (i) => i.kind === "event",
    async setup(items, world: World) {
      const ip = backend("lab-radicale", "lab/radicale");
      const base = `http://${ip}:5232`;
      await waitFor(async () => (await http(`${base}/`)).status < 500, "radicale");
      const cal = `${base}/lab/calendar/`;
      const mk = await http(cal, { method: "MKCALENDAR", headers: { Authorization: `Basic ${btoa("lab:lab")}` } });
      if (!mk.ok && mk.status !== 405) throw new Error(`MKCALENDAR ${mk.status}`);
      for (const i of items) {
        const { start, end } = eventTimes(i);
        const where = /Where: (.+)/.exec(i.text)?.[1] ?? "";
        const body = [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "PRODID:-//eden-lab//EN",
          "BEGIN:VEVENT",
          `UID:${worldKey(i)}`,
          `DTSTAMP:${ics(new Date(world.now))}`,
          `DTSTART:${ics(start)}`,
          `DTEND:${ics(end)}`,
          `SUMMARY:${icsText(i.title)}`,
          `DESCRIPTION:${icsText(i.text)}`,
          ...(where ? [`LOCATION:${icsText(where)}`] : []),
          "END:VEVENT",
          "END:VCALENDAR",
          "",
        ].join("\r\n");
        const put = await http(`${cal}${worldKey(i)}.ics`, {
          method: "PUT",
          headers: { "Content-Type": "text/calendar", Authorization: `Basic ${btoa("lab:lab")}` },
          body,
        });
        if (!put.ok) throw new Error(`PUT event ${put.status}`);
      }
      // The window a calendar lookup would use: a month back, three months ahead.
      window = {
        start: new Date(world.now - 30 * 86_400_000).toISOString().slice(0, 10),
        end: new Date(world.now + 90 * 86_400_000).toISOString().slice(0, 10),
      };
    },
    transport: () =>
      stdio("lab/caldav", {
        network: NET,
        env: { CALDAV_URL: "http://lab-radicale:5232/lab/", CALDAV_USERNAME: "lab", CALDAV_PASSWORD: "lab" },
      }),
    searchTool: {
      name: "caldav_search_events",
      args: (text) => ({ query: text, start_date: window.start, end_date: window.end }),
    },
    // Not annotated; it fetches the window's events and filters them in memory (src/mcp_caldav/client.py:845-880).
    trustedReadTools: ["caldav_search_events"],
    async teardown() {
      removeContainer("lab-radicale");
    },
  };
}

/**
 * Values of every numeric `field` in a raw tool result (JSON text blocks, parsed where they parse), on objects that
 * also have every key in `with`.
 */
export function numbersIn(raw: string, field: string, withKeys: string[] = []): number[] {
  const out: number[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o[field] === "number" && withKeys.every((k) => k in o)) out.push(o[field] as number);
      for (const x of Object.values(o)) if (x && typeof x === "object") walk(x);
    }
  };
  try {
    for (const block of JSON.parse(raw) as { text?: string }[]) {
      try {
        walk(JSON.parse(block.text ?? ""));
      } catch {
        // Not JSON: no uids to read.
      }
    }
  } catch {
    return [];
  }
  return out;
}

/** The mail headers a world mail item states in its first lines (From, To, Date), and its body. */
export function mailParts(item: WorldItem): { headers: Record<string, string>; body: string } {
  const lines = item.text.split("\n");
  const headers: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length && lines[i]!.trim(); i++) {
    const m = /^(From|To|Cc|Date): (.*)$/.exec(lines[i]!);
    if (!m) break;
    headers[m[1]!] = m[2]!;
  }
  return { headers, body: lines.slice(i).join("\n").trim() };
}

/** Delivers messages over LMTP, in order, on one connection; the mailbox assigns UIDs in that order. */
async function lmtp(host: string, port: number, rcpt: string, messages: string[]): Promise<void> {
  const sock = connect(port, host);
  let buf = "";
  let waiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  sock.on("data", (d) => {
    buf += d.toString();
    waiter?.resolve();
  });
  sock.on("error", (e) => waiter?.reject(e));
  sock.on("close", () => waiter?.reject(new Error("LMTP: connection closed")));
  // A peer that accepts and then goes silent must fail the setup, not hang it.
  sock.setTimeout(15_000, () => sock.destroy(new Error("LMTP: no reply in 15 s")));
  // One reply: lines up to the one whose code is followed by a space.
  const reply = async (): Promise<string> => {
    for (;;) {
      const m = /(?:^|\r\n)(\d{3}) [^\r\n]*\r\n/.exec(buf);
      if (m) {
        const end = m.index + m[0].length;
        const r = buf.slice(0, end);
        buf = buf.slice(end);
        if (!/^[23]/.test(m[1]!)) {
          sock.destroy();
          throw new Error(`LMTP: ${r.trim()}`);
        }
        return r;
      }
      await new Promise<void>((resolve, reject) => (waiter = { resolve, reject }));
      waiter = null;
    }
  };
  const send = (line: string) => sock.write(`${line}\r\n`);
  await new Promise<void>((resolve, reject) => sock.once("connect", resolve).once("error", reject));
  await reply();
  send("LHLO lab");
  await reply();
  for (const msg of messages) {
    send("MAIL FROM:<seed@lab.invalid>");
    await reply();
    send(`RCPT TO:<${rcpt}>`);
    await reply();
    send("DATA");
    await reply();
    const body = msg.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    sock.write(`${body}\r\n.\r\n`);
    await reply();
  }
  send("QUIT");
  sock.end();
}

const DOVECOT_CONF = "disable_plaintext_auth = no\nssl = no\nauth_mechanisms = plain login\n";

/**
 * An IMAP MCP server over Dovecot: the world's mail, delivered in order, so UID n is the n-th item. Its search has
 * no free-text argument; `field` is where the operator's mapping puts the query (IMAP BODY or SUBJECT, substring).
 */
export function imap(field: "body" | "subject"): LabConnector {
  let dir = "";
  let order: string[] = [];
  return {
    name: `imap-${field}`,
    semantics: `field criteria only; the query goes to IMAP ${field.toUpperCase()}, one substring (Dovecot, no FTS)`,
    accepts: (i) => i.sourceId === "gmail",
    async setup(items) {
      dir = tempDir("dovecot");
      writeFileSync(join(dir, "lab.conf"), DOVECOT_CONF);
      // The server's own account file; an empty password is its marker for "from the environment".
      const account = { id: "lab", name: "lab", host: "lab-dovecot", port: 143, user: "lab", password: "", tls: false };
      writeFileSync(join(dir, "accounts.json"), JSON.stringify([{ ...account, allowStartTLS: false }]));
      const ip = backend("lab-dovecot", "mirror.gcr.io/dovecot/dovecot:2.3.21", [
        "-v",
        `${dir}/lab.conf:/etc/dovecot/conf.d/lab.conf:ro`,
      ]);
      const messages = items.map((i) => {
        const { headers, body } = mailParts(i);
        const date = new Date(i.updatedAt).toUTCString().replace("GMT", "+0000");
        return [
          `From: ${headers.From ?? "unknown@lab.invalid"}`,
          `To: ${headers.To ?? "robin@northwind.co"}`,
          ...(headers.Cc ? [`Cc: ${headers.Cc}`] : []),
          `Subject: ${i.title}`,
          `Date: ${date}`,
          `Message-ID: <${worldKey(i)}@lab.invalid>`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: 8bit",
          "",
          body,
        ].join("\n");
      });
      await waitFor(async () => {
        await lmtp(ip, 24, "lab", []);
        return true;
      }, "dovecot");
      await lmtp(ip, 24, "lab", messages);
      order = items.map(worldKey);
    },
    transport: () =>
      stdio("lab/imap", {
        network: NET,
        mounts: [`${dir}:/root/.imap-mcp`],
        env: { IMAP_MCP_READ_ONLY: "1", IMAP_MCP_ACCOUNT_LAB_IMAP_PASSWORD: "pass" },
      }),
    searchTool: { name: "imap_search_emails", args: (text, limit) => ({ [field]: text, limit, accountId: "lab" }) },
    identify: (raw) =>
      numbersIn(raw, "uid")
        .map((uid) => order[uid - 1]!)
        .filter(Boolean),
    // The server runs with IMAP_MCP_READ_ONLY=1 (read tools only); its tools carry no annotations.
    trustedReadTools: ["imap_search_emails"],
    async teardown() {
      removeContainer("lab-dovecot");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The official Chroma MCP server over an embedded Chroma store: vector search with the default embedding model. */
export function chroma(): LabConnector {
  let dir = "";
  return {
    name: "chroma",
    semantics: "vector similarity (all-MiniLM-L6-v2, Chroma's default); always returns n_results, never empty",
    accepts: all,
    async setup(items) {
      dir = tempDir("chroma");
      mkdirSync(join(dir, "data"));
      const rows = items.map((i) =>
        JSON.stringify({ id: worldKey(i), document: `${i.title}\n\n${i.text}`, kind: i.kind }),
      );
      writeFileSync(join(dir, "items.jsonl"), rows.join("\n") + "\n");
      const p = Bun.spawnSync(
        [
          "docker",
          "run",
          "--rm",
          "--network",
          "none",
          "-v",
          `${dir}/data:/data`,
          "-v",
          `${dir}/items.jsonl:/items.jsonl:ro`,
        ].concat(["--entrypoint", "python", "lab/chroma", "/seed.py", "/items.jsonl"]),
        { stdout: "pipe", stderr: "pipe" },
      );
      if (p.exitCode !== 0) throw new Error(`chroma seed: ${p.stderr.toString().slice(-500)}`);
    },
    transport: () => stdio("lab/chroma", { mounts: [`${dir}/data:/data`] }),
    searchTool: {
      name: "chroma_query_documents",
      args: (text, limit) => ({ collection_name: "items", query_texts: [text], n_results: limit }),
    },
    // Its tools carry no annotations; chroma_query_documents only queries (src/chroma_mcp/server.py).
    trustedReadTools: ["chroma_query_documents"],
    async teardown() {
      Bun.spawnSync(["docker", "run", "--rm", "-v", `${dir}:/w`, "--entrypoint", "rm", "lab/chroma", "-rf", "/w/data"]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const GITEA_PASSWORD = "lab-password-0123456789";

/**
 * The official Gitea MCP server over Gitea: every item filed as an issue in one repository, in order, so issue n is
 * the n-th item. `indexer` is the deployment's issue indexer, an admin setting (`db`: SQL LIKE; `bleve`: full text).
 */
export function gitea(indexer: "db" | "bleve"): LabConnector {
  let token = "";
  let order: string[] = [];
  return {
    name: `gitea-${indexer}`,
    semantics: `issue search through the deployment's indexer (${indexer}); required free-text query`,
    accepts: all,
    async setup(items) {
      const ip = backend("lab-gitea", "docker.gitea.com/gitea:1.22", [
        ...["-e", "GITEA__security__INSTALL_LOCK=true", "-e", "GITEA__database__DB_TYPE=sqlite3"],
        ...[
          "-e",
          `GITEA__indexer__ISSUE_INDEXER_TYPE=${indexer}`,
          "-e",
          "GITEA__server__ROOT_URL=http://lab-gitea:3000/",
        ],
        ...["-e", "GITEA__api__MAX_RESPONSE_ITEMS=100", "-e", "GITEA__service__DISABLE_REGISTRATION=true"],
      ]);
      const base = `http://${ip}:3000/api/v1`;
      await waitFor(async () => (await http(`${base}/version`)).ok, "gitea", 120_000);
      docker(
        ["exec", "-u", "git", "lab-gitea", "gitea", "admin", "user", "create", "--admin", "--username", "lab"].concat([
          "--password",
          GITEA_PASSWORD,
          "--email",
          "lab@lab.invalid",
          "--must-change-password=false",
        ]),
      );
      const basic = { Authorization: `Basic ${btoa(`lab:${GITEA_PASSWORD}`)}`, "Content-Type": "application/json" };
      const tok = await http(`${base}/users/lab/tokens`, {
        method: "POST",
        headers: basic,
        body: JSON.stringify({ name: "lab", scopes: ["all"] }),
      });
      if (!tok.ok) throw new Error(`gitea token ${tok.status}: ${(await tok.text()).slice(0, 200)}`);
      token = ((await tok.json()) as { sha1: string }).sha1;
      const auth = { Authorization: `token ${token}`, "Content-Type": "application/json" };
      const repo = await http(`${base}/user/repos`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ name: "items" }),
      });
      if (!repo.ok) throw new Error(`gitea repo ${repo.status}`);
      for (const i of items) {
        const r = await http(`${base}/repos/lab/items/issues`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ title: i.title, body: i.text }),
        });
        if (!r.ok) throw new Error(`gitea issue ${r.status}: ${(await r.text()).slice(0, 200)}`);
      }
      order = items.map(worldKey);
      // The bleve indexer works from a queue: wait until the last issue is searchable by its own title.
      const last = items.at(-1)!;
      const q = encodeURIComponent(last.title);
      await waitFor(
        async () => {
          const res = await http(`${base}/repos/issues/search?q=${q}&limit=50`, { headers: auth });
          return ((await res.json()) as { number: number }[]).some((x) => x.number === items.length);
        },
        "gitea indexing",
        300_000,
      );
    },
    transport: () =>
      stdio("lab/gitea", { network: NET, env: { GITEA_HOST: "http://lab-gitea:3000", GITEA_ACCESS_TOKEN: token } }),
    searchTool: {
      name: "search_issues",
      args: (text, limit) => ({ query: text, state: "all", type: "issues", per_page: limit }),
    },
    identify: (raw) =>
      numbersIn(raw, "number", ["title"])
        .map((n) => order[n - 1]!)
        .filter(Boolean),
    async teardown() {
      removeContainer("lab-gitea");
    },
  };
}

export const CONNECTORS: Record<string, () => LabConnector> = {
  memory,
  mcpvault,
  "basic-memory": basicMemory,
  meilisearch,
  caldav,
  "imap-body": () => imap("body"),
  "imap-subject": () => imap("subject"),
  chroma,
  "gitea-db": () => gitea("db"),
  "gitea-bleve": () => gitea("bleve"),
};
