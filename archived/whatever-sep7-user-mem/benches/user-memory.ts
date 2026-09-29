/**
 * User-ready memory gaps. Do not edit after lock.
 * Prints fail count as `metric:` (lower is better).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openMemory, host, MEMORY_MARK, type AgentMemory } from "../../src/index";
import { memoryHookResponse } from "../../packages/cli/src/memory-hook";

const root = mkdtempSync(join(tmpdir(), "user-mem-"));
const origHome = process.env.HOME;
const origEdenHome = process.env.EDEN_HOME;
const origMemDir = process.env.EDEN_MEMORY_DIR;
const fails: string[] = [];

function blob(injected: unknown[]): string {
  return injected
    .map((m) => {
      if (!m || typeof m !== "object") return "";
      const o = m as { role?: string; content?: unknown };
      if (o.role && o.role !== "system") return "";
      return typeof o.content === "string" ? o.content : "";
    })
    .filter(Boolean)
    .join("\n");
}

function notesOf(mem: AgentMemory, asked: string): string {
  return blob(mem.inject([{ role: "user", content: asked }]));
}

function check(id: string, ok: boolean) {
  if (!ok) fails.push(id);
}

{
  const dir = join(root, "persist");
  const a = openMemory({ dir });
  a.observe([{ role: "user", content: "Kai's timezone is Pacific" }]);
  a.close();
  const b = openMemory({ dir });
  check("persist-reopen", /Pacific/i.test(notesOf(b, "What time should I ping Kai about the release?")));
  b.close();
}

{
  const dir = join(root, "hook-ups");
  process.env.EDEN_MEMORY_DIR = dir;
  mkdirSync(dir, { recursive: true });
  memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "Always run bun test before you push." });
  const later = memoryHookResponse({
    hook_event_name: "UserPromptSubmit",
    prompt: "What should I run before I push?",
  });
  const ctx = String((later as { hookSpecificOutput?: { additionalContext?: string } } | null)?.hookSpecificOutput?.additionalContext || "");
  check("hook-inject", /bun test/i.test(ctx) && ctx.includes(MEMORY_MARK));
}

{
  const dir = join(root, "hook-start");
  process.env.EDEN_MEMORY_DIR = dir;
  mkdirSync(dir, { recursive: true });
  memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "Never commit .env or credentials.json" });
  const start = memoryHookResponse({ hook_event_name: "SessionStart" });
  const ctx = String((start as { hookSpecificOutput?: { additionalContext?: string } } | null)?.hookSpecificOutput?.additionalContext || "");
  check("session-brief", /\.env/i.test(ctx));
}

{
  const dir = join(root, "stop");
  const trans = join(dir, "t.jsonl");
  mkdirSync(dir, { recursive: true });
  writeFileSync(trans, `${JSON.stringify({ type: "user", message: { role: "user", content: "Production deploys use flyctl, never Heroku." } })}\n`);
  process.env.EDEN_MEMORY_DIR = dir;
  const stop = memoryHookResponse({ hook_event_name: "Stop", transcript_path: trans });
  const later = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "Ship this service to production." });
  const ctx = String((later as { hookSpecificOutput?: { additionalContext?: string } } | null)?.hookSpecificOutput?.additionalContext || "");
  check("stop-observe", stop == null && /flyctl/i.test(ctx));
}

{
  process.env.EDEN_MEMORY_DIR = join(root, "failopen");
  mkdirSync(process.env.EDEN_MEMORY_DIR, { recursive: true });
  let threw = false;
  try {
    memoryHookResponse({ hook_event_name: "PreCompact", transcript_path: "/no/such/transcript.jsonl" });
  } catch {
    threw = true;
  }
  check("fail-open", !threw);
}

{
  const dir = join(root, "junk");
  const mem = openMemory({ dir });
  mem.observe([{ role: "user", content: "ok thanks" }]);
  check("junk", mem.memories().length === 0);
  mem.close();
}

{
  const dir = join(root, "secret");
  const mem = openMemory({ dir });
  mem.observe([{ role: "user", content: "The API key is sk-abcdefghijklmnopqrstuvwxyz123456" }]);
  const texts = mem.memories().map((m) => m.text).join("\n");
  check("secrets", !/sk-[A-Za-z0-9]{8,}/.test(texts));
  mem.close();
}

{
  const dir = join(root, "forget");
  const mem = openMemory({ dir });
  const rec = mem.remember("Staging DSN is postgres://staging.internal:5432/app");
  check("forget", mem.forget(rec.id) && !mem.memories().some((m) => m.id === rec.id));
  mem.close();
}

{
  const dir = join(root, "query");
  const mem = openMemory({ dir });
  mem.observe([{ role: "user", content: "Kai's timezone is Pacific" }]);
  const hit = mem.query("timezone Kai ping");
  check("query", hit.some((h) => /Pacific/i.test(h.text)));
  mem.close();
}

{
  const dir = join(root, "agent");
  const a = openMemory({ dir, agent: "claude" });
  const b = openMemory({ dir, agent: "cursor" });
  a.observe([{ role: "user", content: "The claude DSN is postgres://claude.internal:5432/app" }]);
  a.close();
  const notes = notesOf(b, "Connect the app to its database.");
  check("agent-scope", !/claude\.internal/i.test(notes));
  b.close();
}

{
  const dir = join(root, "project");
  const a = openMemory({ dir, project: "alpha" } as { dir: string; project: string });
  a.observe([{ role: "user", content: "The alpha DSN is postgres://alpha.internal:5432/app" }]);
  a.close();
  const b = openMemory({ dir, project: "beta" } as { dir: string; project: string });
  b.observe([{ role: "user", content: "The beta DSN is postgres://beta.internal:5432/app" }]);
  b.close();
  const a2 = openMemory({ dir, project: "alpha" } as { dir: string; project: string });
  const b2 = openMemory({ dir, project: "beta" } as { dir: string; project: string });
  const probe = "Connect the app to its database.";
  const notesA = notesOf(a2, probe);
  const notesB = notesOf(b2, probe);
  check("project-scope", /alpha\.internal/i.test(notesA) && !/beta\.internal/i.test(notesA) && /beta\.internal/i.test(notesB) && !/alpha\.internal/i.test(notesB));
  a2.close();
  b2.close();
}

{
  const dir = join(root, "hook-cwd");
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  delete process.env.EDEN_MEMORY_DIR;
  process.env.HOME = home;
  process.env.EDEN_HOME = home;
  memoryHookResponse({
    hook_event_name: "UserPromptSubmit",
    cwd: join(dir, "repo-a"),
    prompt: "The repo-a DSN is postgres://repo-a.internal:5432/app",
  });
  memoryHookResponse({
    hook_event_name: "UserPromptSubmit",
    cwd: join(dir, "repo-b"),
    prompt: "The repo-b DSN is postgres://repo-b.internal:5432/app",
  });
  const later = memoryHookResponse({
    hook_event_name: "UserPromptSubmit",
    cwd: join(dir, "repo-a"),
    prompt: "Connect the app to its database.",
  });
  const ctx = String((later as { hookSpecificOutput?: { additionalContext?: string } } | null)?.hookSpecificOutput?.additionalContext || "");
  check("hook-cwd", /repo-a\.internal/i.test(ctx) && !/repo-b\.internal/i.test(ctx));
}

{
  const dir = join(root, "supersede");
  const mem = openMemory({ dir });
  mem.observe([{ role: "user", content: "Kai's timezone is Pacific" }]);
  mem.observe([{ role: "user", content: "Kai's timezone is Eastern" }]);
  const notes = notesOf(mem, "What time should I ping Kai about the release?");
  check("supersede", /Eastern/i.test(notes) && !/Pacific/i.test(notes));
  mem.close();
}

{
  const dir = join(root, "dedup");
  const mem = openMemory({ dir });
  mem.observe([{ role: "user", content: "Always run bun test before you push." }]);
  mem.observe([{ role: "user", content: "Always run bun test before you push." }]);
  check("dedup", mem.memories().filter((m) => /bun test/i.test(m.text)).length === 1);
  mem.close();
}

{
  const dir = join(root, "cap");
  const mem = openMemory({ dir });
  for (let i = 0; i < 40; i++) mem.remember(`Service s${i} lives in namespace ns-${i} on cluster prod.`);
  const notes = notesOf(mem, "Which namespace does the service live in on the prod cluster?");
  const bullets = notes.split("\n").filter((l) => l.startsWith("- ")).length;
  check("inject-cap", bullets > 0 && bullets <= 8);
  mem.close();
}

{
  const dir = join(root, "body");
  const mem = openMemory({ dir });
  mem.observe([{ role: "user", content: "Kai's timezone is Pacific" }]);
  const out = mem.injectBody({ messages: [{ role: "user", content: "What time should I ping Kai about the release?" }] });
  const msgs = (out.messages as unknown[]) || [];
  check("inject-body", blob(msgs).includes(MEMORY_MARK) && /Pacific/i.test(blob(msgs)));
  mem.close();
}

{
  const dir = join(root, "http");
  const port = 18000 + Math.floor(Math.random() * 2000);
  const h = host({ dir, port });
  try {
    const base = h.url.endsWith("/") ? h.url : `${h.url}/`;
    const obs = await fetch(`${base}observe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Kai's timezone is Pacific" }] }),
    });
    const inj = await fetch(`${base}inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "What time should I ping Kai about the release?" }] }),
    });
    const listed = await fetch(`${base}memories`);
    const q = await fetch(`${base}query?q=timezone`);
    const injJ = (await inj.json()) as { messages?: unknown[] };
    const listedJ = (await listed.json()) as { text?: string }[];
    const qJ = (await q.json()) as { text?: string }[];
    check("http", obs.ok && /Pacific/i.test(blob(injJ.messages || [])) && listedJ.some((m) => /Pacific/i.test(String(m.text || ""))) && qJ.some((m) => /Pacific/i.test(String(m.text || ""))));
  } catch {
    check("http", false);
  }
  h.stop();
}

{
  const dir = join(root, "plugin");
  mkdirSync(dir, { recursive: true });
  const script = join(import.meta.dir, "../../plugins/eden-memory/scripts/hook.ts");
  const env = { ...process.env, EDEN_MEMORY_DIR: dir };
  spawnSync("bun", [script], {
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Always run bun test before you push." }),
    encoding: "utf8",
    env,
  });
  const r = spawnSync("bun", [script], {
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "What should I run before I push?" }),
    encoding: "utf8",
    env,
  });
  check("plugin", r.status === 0 && /bun test/i.test(r.stdout || ""));
}

{
  const dir = join(root, "aliases");
  process.env.EDEN_MEMORY_DIR = dir;
  mkdirSync(dir, { recursive: true });
  memoryHookResponse({ hook_event_name: "user_prompt_submit", prompt: "Never commit .env or credentials.json" });
  const start = memoryHookResponse({ hook_event_name: "session_start" });
  const later = memoryHookResponse({ hook_event_name: "user_prompt_submit", prompt: "Commit these files from the working tree." });
  const brief = String((start as { hookSpecificOutput?: { additionalContext?: string } } | null)?.hookSpecificOutput?.additionalContext || "");
  const ctx = String((later as { hookSpecificOutput?: { additionalContext?: string } } | null)?.hookSpecificOutput?.additionalContext || "");
  check("host-aliases", /\.env/i.test(brief) && /\.env/i.test(ctx));
}

{
  const dir = join(root, "precompact");
  process.env.EDEN_MEMORY_DIR = dir;
  mkdirSync(dir, { recursive: true });
  memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "Kai's timezone is Pacific" });
  const compact = memoryHookResponse({
    hook_event_name: "PreCompact",
    prompt: "What time should I ping Kai about the release?",
  });
  const ctx = String((compact as { hookSpecificOutput?: { additionalContext?: string } } | null)?.hookSpecificOutput?.additionalContext || "");
  check("precompact", /Pacific/i.test(ctx));
}

{
  const dir = join(root, "corrupt");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memories.jsonl"), "{not json\n");
  let threw = false;
  let notes = "";
  try {
    const mem = openMemory({ dir });
    mem.observe([{ role: "user", content: "Kai's timezone is Pacific" }]);
    notes = notesOf(mem, "What time should I ping Kai about the release?");
    mem.close();
  } catch {
    threw = true;
  }
  check("corrupt-jsonl", !threw && /Pacific/i.test(notes));
}

delete process.env.EDEN_MEMORY_DIR;
if (origHome) process.env.HOME = origHome;
else delete process.env.HOME;
if (origEdenHome) process.env.EDEN_HOME = origEdenHome;
else delete process.env.EDEN_HOME;
if (origMemDir) process.env.EDEN_MEMORY_DIR = origMemDir;
else delete process.env.EDEN_MEMORY_DIR;
rmSync(root, { recursive: true, force: true });

console.log(`metric: ${fails.length}`);
console.log(`fail_ids: ${fails.join(",") || "(none)"}`);
console.log(`cases: ${fails.length} failed`);
