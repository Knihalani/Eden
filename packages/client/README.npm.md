# @eden/client

The TypeScript client for Eden, a context partner for personal and proactive agents. It runs beside your agent, reads
your user's connected sources (read-only), puts the context a request needs into your agent's prompt, and answers your
agent's questions. Node 18+, Bun and Deno; one runtime import (`node:crypto`).

```ts
import { ASK_CONTEXT_DESCRIPTION, EdenClient, edenId, guardTools, withContext } from "@eden/client";

const eden = new EdenClient({ apiKey, userId: edenId(user.id), sessionId: edenId(chat.id) });
console.log(await eden.health()); // { ok: true } when the server accepts the key and ids

await eden.observe({ kind: "session_start" }); // when the user connects: Eden starts reading their sources

// Each user message: report it (it waits up to 3 s for Eden's lookup), then put the packet before the model call.
const { injection } = await eden.observe({ kind: "user_message", text });
messages = withContext(messages, await eden.collect(injection)); // keep the returned list as your transcript

// Give the agent Eden's ask as a tool, with Eden's description.
const askTool = { name: "ask_context", description: ASK_CONTEXT_DESCRIPTION, run: (q: string) => eden.ask(q) };

// Report the agent's side, and check acting tools before they run.
await eden.observe({ kind: "tool_call", tool: "send_email", input: args });
const tools = guardTools(eden, { send_email: sendEmail });
```

- **It never throws into your agent's loop.** A network error, a timeout or a refusal is "no context". With no
  `onError`, problems are printed once each with their fix (`EDEN_ENV=production`: the first of each kind).
- **Check your integration** against a running server with `eden doctor` (in the Eden repository: `bun run doctor`).
- The full guide is `docs/INTEGRATION.md` in the Eden repository.

MIT licence.
