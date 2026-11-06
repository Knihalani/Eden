import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";

// The example must run with no paid key: a dev server on a free port with the example's sources, then the agent with
// OPENAI_API_KEY unset, which takes the offline stub model. A smoke test of the whole loop (observe, ask, answer).
const root = join(import.meta.dir, "../..");
const env = { ...process.env, OPENAI_API_KEY: "", OPENAI_BASE_URL: "", AGENT_MODEL: "" };

const server = Bun.spawn([process.execPath, join(root, "packages/server/src/main.ts")], {
  cwd: root,
  env: { ...env, EDEN_DEV: "1", PORT: "0", EDEN_SOURCES_FILE: join(import.meta.dir, "sources.json") },
  stdout: "pipe",
  stderr: "inherit",
});
afterAll(() => server.kill());

/** The server's URL, from its "listening on" line. Its stdout can be read only once, so every test shares this. */
const serverUrl = listening();
serverUrl.catch(() => {}); // a server that dies early fails each test that awaits this, not the whole file
async function listening(): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of server.stdout) {
    out += decoder.decode(chunk);
    const m = /listening on (http:\/\/\S+)/.exec(out);
    if (m) return m[1]!;
  }
  throw new Error(`the server exited before listening: ${out}`);
}

/** Runs the agent (the offline stub model) against the dev server with `args` and returns what it printed. */
async function runAgent(args: string[]): Promise<{ out: string; err: string; code: number }> {
  const url = await serverUrl;
  const agent = Bun.spawn([process.execPath, join(import.meta.dir, "agent.ts"), ...args], {
    cwd: root,
    env: { ...env, EDEN_URL: url, EDEN_WAIT_MS: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(agent.stdout).text(),
    new Response(agent.stderr).text(),
    agent.exited,
  ]);
  return { out, err, code };
}

test("the example agent runs offline against a dev server and answers from Eden's context", async () => {
  const { out, err, code } = await runAgent(["move lunch with Priya Raman to Friday"]);
  expect(code).toBe(0);
  expect(err).toContain("offline stub model");
  expect(err).not.toContain("[eden]"); // the client reported no error
  expect(out).toContain("(stub model) Eden says:");
  expect(out).toContain("Lunch with Priya Raman");
}, 20_000);

// A first run with no argument is what a new integrator sees first, so its default prompt must be one the example's
// dateless sources answer: it must cite a calendar item, not print "Nothing in the connected sources."
test("the example agent's default prompt (no argument) cites the sample calendar", async () => {
  const { out, err, code } = await runAgent([]);
  expect(code).toBe(0);
  expect(err).not.toContain("[eden]");
  expect(out).toContain("(stub model) Eden says:");
  expect(out).toContain("[calendar]");
  expect(out).not.toContain("Nothing in the connected sources");
}, 20_000);

test("the agent offers ask_context with the description the server's MCP tool gives", async () => {
  const { ASK_CONTEXT_DESCRIPTION } = await import("@eden/client");
  const source = await Bun.file(join(import.meta.dir, "agent.ts")).text();
  expect(source).toContain("description: ASK_CONTEXT_DESCRIPTION");
  expect(ASK_CONTEXT_DESCRIPTION).toContain("connected sources");
});
