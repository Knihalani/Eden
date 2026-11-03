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

/** The server's URL, from its "listening on" line. */
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

test("the example agent runs offline against a dev server and answers from Eden's context", async () => {
  const url = await listening();
  const agent = Bun.spawn(
    [process.execPath, join(import.meta.dir, "agent.ts"), "move lunch with Priya Raman to Friday"],
    { cwd: root, env: { ...env, EDEN_URL: url, EDEN_WAIT_MS: "0" }, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(agent.stdout).text(),
    new Response(agent.stderr).text(),
    agent.exited,
  ]);
  expect(code).toBe(0);
  expect(err).toContain("offline stub model");
  expect(err).not.toContain("[eden]"); // the client reported no error
  expect(out).toContain("(stub model) Eden says:");
  expect(out).toContain("Lunch with Priya Raman");
}, 20_000);

test("the agent offers ask_context with the description the server's MCP tool gives", async () => {
  const { ASK_CONTEXT_DESCRIPTION } = await import("@eden/client");
  const source = await Bun.file(join(import.meta.dir, "agent.ts")).text();
  expect(source).toContain("description: ASK_CONTEXT_DESCRIPTION");
  expect(ASK_CONTEXT_DESCRIPTION).toContain("connected sources");
});
