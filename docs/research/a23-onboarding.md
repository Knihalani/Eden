# A23: three new adopters, clone to first packet (2026-11-07)

Session A23 of the afternoon audit ([audit-1107-plan.md](audit-1107-plan.md)), after A4 and A7
([a4-adoption.md](a4-adoption.md), [a7-adoption.md](a7-adoption.md)). Decision D365. Branch `claude/a23-onboarding`
from `claude/lucid-hypatia-v9wqk5` (2ce886c6). Spend: $0 (no model call; every run with the key variables cleared).
Every number below is from a command run in this session on a 4-core container; "time to first packet" is wall time
from a fresh checkout with `bun install` done (3.5 s here) to the first `<context …>` packet the agent would see.

## In plain words

Three people with no prior context followed only the public docs. The no-key demo and the in-repo quickstart were
already good (a packet in under half a second). The problems were at the edges an adopter actually lives at:

1. **A TypeScript developer could not install the client in their own project at all.** `@eden/client` points at
   `@eden/protocol` with `workspace:*` and ships TypeScript, so `bun add /path/to/Eden/packages/client` fails ("failed
   to resolve") and npm cannot do better; nothing documented another route. Now `bun run pack:client` writes a
   standalone package; `npm install` it and Node, Bun or TypeScript use it. **Before: no packet without reading the
   source. After: 3.2 s** (pack, `npm install`, a Node script's first packet).
2. **The Python team behind the proxy got a packet first time (0.44 s)** but every mistake was silent: no user id,
   an upstream URL without `/v1`, a server that was down or refusing the key. Now the proxy says each of these, once,
   at startup or on the first request, and has its own `/healthz`.
3. **The ops person's first contact with a mistake was a stack trace.** A short key, no key, a busy port, a missing
   sources file or an unwritable data directory printed ten lines of Bun's source excerpt with the message buried.
   Now each is one `eden: …` line naming the setting, exit 2. The Dockerfile header shows how to generate a key and
   where the users file goes inside the container. **Time to first answer under 1 s** once installed, before and
   after; the image itself could not be built here (no Docker daemon), so the smoke test runs the image's command.

Each path now has a smoke test in `bun run check` (`examples/onboarding/`, no network, no keys).

## Method

Path (a) and the fixes were done in the main session; a forked subagent walked (b) and (c) without editing, and its
findings were checked by hand where fixed. Every command ran with `OPENROUTER_API_KEY`, `HAIKU_API_KEY` and
`OPENAI_API_KEY` unset (the container has an OpenRouter key: the first quickstart run, with it set, printed
"model roles on", which a no-key adopter would not see).

| Path | Before | After |
| --- | --- | --- |
| Demo (`bun run demo`) | 1.46 s, caught 3 of 3 | unchanged |
| (a) Quickstart in the repo (`bun run dev` + curl) | server up 0.23 s, packet on the first curl | unchanged |
| (a) TS agent in its own repo | blocked (`@eden/protocol@workspace:* failed to resolve`) | 3.2 s: `pack:client` 1.6 s, `npm install` 0.6 s, first packet |
| (b) Python via the proxy (urllib, `openai` 3.46 also works) | 0.44 s for three processes and one call | unchanged; mistakes now visible |
| (c) Production command (keyed, 2 processes) | router up 278 ms, `/healthz` `{"ok":true,"processes":2,"up":2}` | unchanged; mistakes one line |

## Stumbles, and what was done

| # | Path | Stumble (as observed) | Fix |
| --- | --- | --- | --- |
| 1 | a | `bun add …/packages/client`: `error: @eden/protocol@workspace:* failed to resolve`; npm 404 for `@eden/client` | `bun run pack:client` (D365); README and INTEGRATION.md say how to install from another repo |
| 2 | a, b | Server down: `[eden] ECONNREFUSED: Unable to connect. Is the computer able to access the url?` (no URL, no route), on every call, from the TS client and the proxy | Both clients: `eden /v1/events: cannot reach http://127.0.0.1:8790 (…)`; every URL in the line loses credentials, query and fragment (`redactUrls`), Node's own message included; tested in TS, Python and under Node |
| 3 | a, c | `EDEN_API_KEYS` missing or short: 10 lines of config.ts source and a stack | `configOrExit`: one line, exit 2 |
| 4 | a, c | Port in use: Bun's source excerpt, "Is port 8790 in use?" | `eden: 127.0.0.1:8790 is in use: stop the other server, or set PORT to a free port` |
| 5 | c | `EDEN_USER_SOURCES_FILE=missing.json`: raw `ENOENT … stat` object | one line naming the file and the settings that name files |
| 6 | c | `EDEN_HOME` unwritable: `ENOENT: … mkdir '/proc/nope'` without the setting | the line names `EDEN_HOME` |
| 7 | b | No `x-eden-user-id` and no `user`: request goes upstream with no packet and no word | said once on stderr (no content) |
| 8 | b | `EDEN_PROXY_UPSTREAM=http://host` (no `/v1`): upstream gets `/chat/completions`, a 404 at the first call | warned at startup |
| 9 | b | Keyed server, proxy without `EDEN_API_KEY`: a 401 line per request, nothing at startup | one `/v1/whoami` probe at startup: reachable and key accepted, or why not |
| 10 | b, c | `GET /healthz` on the proxy was forwarded to the model provider | answered by the proxy |
| 11 | b | `PROXY_PORT`, `PROXY_HOST`, `EDEN_URL` documented only in the proxy's source | README and INTEGRATION.md |
| 12 | b | `pip install ./packages/client-python` leaves `eden_client.egg-info/` untracked | `.gitignore` |
| 13 | a | Quickstart output unexplained: `pending: true`; `/v1/ask` citing `(shown above)` | README explains both (an item is delivered once a session) |
| 14 | c | Header: `<a key of 16+ characters>`, `-v ./sources:/sources:ro with EDEN_USER_SOURCES_FILE` | `$(openssl rand -hex 24)`, `-e EDEN_USER_SOURCES_FILE=/sources/users.json`, Bearer only, re-read on change |
| 15 | all | README status "M0 done. Next: M1" read as abandoned, and nothing says packages are unpublished | honest status line; install-from-checkout named |

Not fixed, minor: with `EDEN_PROCESSES>1` each child prints its own "listening on 127.0.0.1:<random port>" line
before the router's; `x-api-key` is not accepted (Bearer only, now documented); a reused volume after changing
`EDEN_PROCESSES` prints a "moved the source-map rows" line per file, including for zero users.

## Top remaining reasons a team would not adopt Eden (not fixable in this session), ranked

1. **The one-line proxy speaks only OpenAI chat completions.** (Anthropic's Messages API and OpenAI's Responses API added 2026-11-10, D653 and D656,
   o2-proxy-messages.md; the Responses route is not yet checked against the real API.) Teams on the Anthropic Messages API or OpenAI's
   Responses API must use the SDK instead. Fix: the same insertion for `/v1/messages` and `/v1/responses` in
   `@eden/proxy`, with a smoke test each.
2. **Nothing is published.** No npm package, no PyPI package, no image in a registry, no versions or changelog; every
   adopter builds from a checkout. Fix: publish `pack:client`'s output and `eden-client`, push tagged images, and a
   release note per version (needs the owner's accounts).
3. **Connecting a user's real accounts is the tenant's job.** Eden reads MCP connectors with the user's tokens, but
   OAuth, token refresh and the per-user directory are left to the tenant (presets name tools; `examples/oauth-directory`
   is a sketch). Fix: a hosted or reference OAuth directory for Gmail, Calendar and Drive, end to end.
4. **One host only.** The router spreads users over cores on one machine; item text and sessions live in memory, so
   several replicas need sticky routing by user, which is not documented or tested. Fix: a documented sticky key
   (tenant and user) for a load balancer, and a test with two servers.
5. **Rotating a tenant key needs a restart** (`EDEN_API_KEYS` is read at startup). Fix: re-read a keys file on change,
   as the users file already is.
6. **Model roles only through OpenRouter**, and its ZDR status is unverified (THREAT-MODEL.md). Teams with a direct
   Anthropic or OpenAI contract cannot use it for Eden's background cards. Fix: a direct-provider transport for the
   model roles, behind the same budgets.
7. **Bun is required to run the server** (the image hides it; a Node-only ops team must accept the image). Fix: none
   cheap; the image is the answer, now with a smoke test of its command.

## Review

The reviewer subagent returned REQUEST_CHANGES with eight findings, all fixed:

1. **The gate went red about one run in three** (`injection.test.ts` long-padding: `Buffer.from(text, "latin1")`
   threw "TypedArray.from requires … a function", so that worker's global `Buffer` was not Node's). No single new file
   caused it: each alone beside the engine passed 4 of 4, so it rode on how `bun test --parallel` scheduled files.
   The pack now runs as its own process, as an adopter runs it, and `packed-text.ts` imports `Buffer` from
   `node:buffer` instead of using the global (the same object normally; no engine behaviour change). After: `engine +
   examples` 0 failures in 6 runs (1 in 3 before the import), `bun run check` green 3 of 3. The base branch passed 6
   of 6 on the same subset, so the latent fault predates this branch but these files exposed it.
   Running the pack as a process also found a real bug: run from another directory it could not find Bun's types
   (type roots now come from the repository).
2. **Credentials under Node:** Node's fetch refuses a URL with `user:password@` and quotes it whole in its message;
   the first version printed that message. Every URL in the error line is now stripped of credentials, query and
   fragment, and the smoke test checks it under Node. No `cause` is kept (it carried the same text).
3. **Several processes:** a busy port or a child that exited before listening went around the one-line path; the
   router now lets main.ts print it (`eden: …`, exit 2), tested with `EDEN_PROCESSES=2`.
4. The proxy's own log lines redact `EDEN_URL` and the upstream the same way.
5. The startup probe waits 5 s (not 800 ms), and an answer that arrived but could not be read is no longer "cannot
   reach" (both clients).
6. A malformed `EDEN_PROXY_UPSTREAM` (`https://`) is one line, exit 2, not a stack.
7. The smoke tests take port 0 and read the listening line (no port race), and skip visibly without Node.
8. A 178-column Dockerfile comment line (the line checker does not scan the Dockerfile).

The re-review approved, with three low notes: a password containing `@` leaked its tail (fixed: the credential part
now runs to the last `@` before the host, tested in both clients); with several processes the router still prints
"restarting in 1000 ms" for a child that failed before listening, before the final `eden:` line (left as it was); a
timeout while the body is read is reported as "an unreadable answer" (rare, left).

## Checks

`bun run check` green 3 of 3 on the final tree; `bun run eval` (no-model) identical to the base branch's JSON apart
from latency (no engine behaviour change).
