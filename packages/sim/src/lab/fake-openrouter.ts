/**
 * A $0 stand-in for OpenRouter, loaded with `bun --preload` before a lab harness (pi-ab-resume.test.ts): it replaces
 * the global `fetch` for openrouter.ai only (every other host is refused, so a test can never reach the network) and
 * answers the agent's streamed chat completions with a fixed reply and the grader's JSON call with a verdict, both
 * derived from the request alone. Lab test tooling, never loaded by a real run.
 *
 * - `FAKE_LOG`: a file that gets one line per call (`agent <first words of the user turn>` or `grader`).
 * - `FAKE_KILL_AFTER=N`: the process kills itself (SIGKILL) when its agent call N+1 arrives, as a container restart
 *   would cut a run short.
 */
import { appendFileSync } from "node:fs";

const log = process.env.FAKE_LOG ?? "";
const killAfter = Number(process.env.FAKE_KILL_AFTER ?? "-1");
let agentCalls = 0;

type Body = { stream?: boolean; messages?: { role: string; content: unknown }[] };

const lastUser = (b: Body) => {
  const m = [...(b.messages ?? [])].reverse().find((x) => x.role === "user");
  const c = m?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? "").join("") : "";
};

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("openrouter.ai")) throw new Error(`fake-openrouter: no network in tests (${url})`);
  const raw = init?.body ?? (input instanceof Request ? await input.text() : "");
  const body = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer)) as Body;
  if (body.stream) {
    agentCalls++;
    if (killAfter >= 0 && agentCalls > killAfter) process.kill(process.pid, "SIGKILL");
    const asked = lastUser(body).replace(/\s+/g, " ").trim().slice(0, 60);
    if (log) appendFileSync(log, `agent ${asked}\n`);
    const text = `I will do that: ${asked}`;
    return sse([
      {
        id: "f",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: text } }],
      },
      { id: "f", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      {
        id: "f",
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 },
      },
    ]);
  }
  if (log) appendFileSync(log, "grader\n");
  // Fact 1 holds when the request (quoted back in the answer) is an even number of characters long: deterministic, and
  // both verdicts occur.
  const request = /<request>([\s\S]*?)<\/request>/.exec(lastUser(body))?.[1] ?? "";
  const verdict = JSON.stringify({ "1": request.length % 2 === 0, "2": false });
  return Response.json({
    choices: [{ message: { role: "assistant", content: verdict } }],
    usage: { prompt_tokens: 200, completion_tokens: 8, cost: 0.0002 },
  });
}) as typeof fetch;
