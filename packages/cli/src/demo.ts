import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The TicketShip sitting script, relative to the root of a clone. */
export const DEMO_REL = join("apps", "control", "src", "demo.ts");
export const DEMO_MISSING = `demo: missing clone path · need ${DEMO_REL}`;

const KNOWN_FLAGS = new Set(["--help", "-h"]);

/** A /v1/inbox candidate as it arrives on the wire. parseInbox only checks that it is an object. */
export type InboxCandidate = {
  id?: string;
  verdict?: string;
  program?: { name?: string; sequence?: string[] } | null;
  manifest?: { llmReduction?: number } | null;
  refusal?: { reason?: string } | null;
};

export type DemoInbox = { candidates: InboxCandidate[]; notice: string | null };

/** A /v1/tools?state=live row. parseLiveTools keeps only rows with a string id. */
export type LiveToolRow = { id: string; name?: string };

export type PlayPick = { id: string | undefined; name: string | undefined; reused: boolean };

export type DemoSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: "inherit";
  stderr: "inherit";
  stdin: "inherit";
};

/** Starts the sitting script. Tests inject one; the default is Bun.spawn. */
export type DemoSpawn = (cmd: string[], opts: DemoSpawnOptions) => { exited: Promise<number> };

export type DemoCliOptions = { scriptPath?: string | null; spawn?: DemoSpawn };

/** A refused or malformed inbox body is one `demo:` sentence and an empty list, never a throw. */
export function parseInbox(body: unknown): DemoInbox {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const raw = (body as { candidates?: unknown }).candidates;
    if (Array.isArray(raw)) {
      return {
        candidates: raw.filter((c): c is InboxCandidate => Boolean(c) && typeof c === "object"),
        notice: null,
      };
    }
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) {
      return { candidates: [], notice: `demo: /v1/inbox ${error.trim()}` };
    }
  }
  return { candidates: [], notice: "demo: /v1/inbox is not a candidates object" };
}

/** A fresh PASS candidate wins; otherwise replay a tool already live from an earlier sitting. */
export function pickPlayTool(pass: InboxCandidate | undefined, live: LiveToolRow[]): PlayPick | null {
  if (pass) return { id: pass.id, name: pass.program?.name, reused: false };
  const t = live[0];
  return t ? { id: t.id, name: t.name, reused: true } : null;
}

export function parseLiveTools(body: unknown): LiveToolRow[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return [];
  const raw = (body as { tools?: unknown }).tools;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is LiveToolRow => Boolean(t) && typeof t === "object" && typeof t.id === "string");
}

export function demoHelp(): string {
  return `eden demo — TicketShip sitting

  eden demo              Compile, Approve inside the demo, play T-100, stay up
  eden demo --help       This letter; does not start the server

The demo script Approves TicketShip (operator). That is different from
eden compile, which Does not Approve.

Uses the local eden_dev key (EDEN_DEV=1) unless you already set EDEN_API_KEY.
Same sitting as bun run demo (${DEMO_REL}). Stays up like wrap.
Port 8788 (or PORT). If wrap is already there: one sentence, exit 1.
Play T-100 after it is up:
EDEN_WRAP_URL=http://127.0.0.1:<port> eden play <name> --input '{"id":"T-100"}'
There is no HTML inbox on this port. Health is /health; candidates are GET /v1/inbox.
`;
}

export function demoPortBusyMessage(port: number): string {
  return `demo: port ${port} is in use · stop eden wrap or set PORT`;
}

export function demoListenLines(origin: string, token: string): string {
  const base = origin.replace(/\/$/, "");
  return `Eden demo is up
  Health    ${base}/health
  Inbox     ${base}/v1/inbox  (Bearer ${token})
  OpenAI    ${base}/v1
  Play      EDEN_WRAP_URL=${base} eden play <name> --input '{"id":"T-100"}'`;
}

export function demoListenFooter(origin: string, token: string): string {
  const base = origin.replace(/\/$/, "");
  // The trailing backslash is a line continuation: the "A compiled hit … not 502." sentence is one output line.
  return `Point an agent at OPENAI_BASE_URL=${base}/v1
Keep OPENAI_API_KEY as the model key. Bearer ${token} is wrap auth, not OpenAI.
A compiled hit plays without a model key (model: eden). \
Miss without a key fail-opens as HTTP 200 (model: eden), not 502.
SDK  POST ${base}/v1/wrap  then  POST ${base}/v1/ingest`;
}

function unknownArg(args: string[]): string | undefined {
  for (const a of args) {
    if (KNOWN_FLAGS.has(a)) continue;
    return a;
  }
  return undefined;
}

/**
 * A sibling demo.js (the npm bundle) wins, so `npm i -g` needs no clone. Otherwise walk up
 * from cwd, then from this file, looking for DEMO_REL.
 */
export function resolveDemoScript(cwd = process.cwd(), from = import.meta.dir): string | null {
  const bundled = join(from, "demo.js");
  if (existsSync(bundled)) return bundled;
  for (const origin of [cwd, from]) {
    let dir = resolve(origin);
    for (let i = 0; i < 12; i++) {
      const hit = join(dir, DEMO_REL);
      if (existsSync(hit)) return hit;
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** The sitting uses the local eden_dev key unless the operator already set EDEN_API_KEY. */
export function demoChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  if (!out.EDEN_API_KEY) {
    out.EDEN_DEV = "1";
    out.EDEN_API_KEY = "eden_dev";
  }
  return out;
}

export async function demoCli(args: string[], opts?: DemoCliOptions): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(demoHelp());
    return 0;
  }
  const unknown = unknownArg(args);
  if (unknown) {
    console.error(`eden demo: unknown flag ${unknown}`);
    return 2;
  }
  const script = opts && "scriptPath" in opts ? opts.scriptPath ?? null : resolveDemoScript();
  if (!script || !existsSync(script)) {
    console.error(DEMO_MISSING);
    return 1;
  }
  const spawn: DemoSpawn = opts?.spawn ?? ((cmd, spawnOpts) => Bun.spawn(cmd, spawnOpts));
  const proc = spawn([process.execPath, script], {
    cwd: resolve(dirname(script), ".."),
    env: demoChildEnv(),
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const code = await proc.exited;
  return typeof code === "number" ? code : 1;
}
