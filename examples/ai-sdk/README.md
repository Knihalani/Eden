# Eden in a Vercel AI SDK agent

`eden-ai-sdk.ts` adds Eden to an agent built on the [Vercel AI SDK](https://ai-sdk.dev) (`ai` 7) with three calls,
and does every integration obligation in [docs/INTEGRATION.md](../../docs/INTEGRATION.md) for you: it sends
`session_start`, reports each user message (waiting for Eden's lookup) and the agent's tool calls, results and
replies, puts Eden's packet into the prompt before every model call and keeps it there on later calls, gives the
agent `ask_context` with Eden's description, and checks each acting tool before it runs.

```ts
import { EdenClient, edenId } from "@eden/client";
import { generateText, stepCountIs } from "ai";
import { edenSession } from "./eden-ai-sdk";

const eden = new EdenClient({ apiKey, userId: edenId(user.id), sessionId: edenId(chat.id) });
const session = edenSession(eden); // one per conversation; keep it for the conversation's life

const result = await generateText({
  model: session.wrap(model), // any AI SDK model
  tools: { ...session.tools, ...session.guard({ send_email }) }, // ask_context; acting tools checked
  stopWhen: stepCountIs(5),
  messages,
});
```

`streamText` takes the same `model` and `tools`. Your sources' change notices come from webhooks, outside the agent's
loop: forward them with `eden.sourceChanged(sourceId, { refs })` (docs/INTEGRATION.md).

## Run it (no keys needed)

From the repository root, after `bun install`:

```bash
# terminal 1: Eden with the example's sources, no auth (dev mode), one process
EDEN_DEV=1 EDEN_PROCESSES=1 EDEN_SOURCES_FILE=examples/personal-agent/sources.json bun run dev

# terminal 2: the agent; without ANTHROPIC_API_KEY it runs an offline scripted model
bun examples/ai-sdk/agent.ts "Can you move my lunch with Priya Raman to 11:30 on Thursday?"
```

On another port (`PORT=8734 bun run dev`), set `EDEN_URL=http://127.0.0.1:8734` for the agent and the doctor. Eden
fails open: against no server the agent still answers, printing `cannot reach …` once and "Eden's packet was not
in my prompt"; that line is how you tell.

With `ANTHROPIC_API_KEY` set it runs `claude-haiku-5-5` (`AGENT_MODEL` to change it), and answers along the lines of
"Priya emailed that she can't do anything before 12:15, so 11:30 may not work for her": the email reached the agent
through Eden's packet, though the agent has no mail tool. Then check what the integration did:

```bash
bun run doctor    # reads EDEN_URL, default http://127.0.0.1:8790
```

## In your own project

Copy `eden-ai-sdk.ts` and install the client and the AI SDK: `npm install ai@7 /path/to/Eden/dist/eden-client` after
`bun run pack:client` in the Eden repository (the client is not on npm yet). The adapter imports only `@eden/client`
and `ai`.

For a script of your own with no model key, the AI SDK's `MockLanguageModelV4` (`ai/test`) stands in for the model;
`agent.ts`'s `scripted()` is a complete one (it asks `ask_context` once, then answers).

`adapter.test.ts` is its smoke test (`bun test examples/ai-sdk`): a scripted model through the real Eden handler, the
doctor's counters, fail-open, and `agent.ts` run as a process against a dev server.
