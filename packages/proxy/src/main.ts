#!/usr/bin/env bun
/**
 * `bun run proxy`: Eden as an OpenAI-compatible proxy in front of the agent's model (D280). Point the agent's
 * `base_url` at `http://127.0.0.1:8791/v1` and send `x-eden-user-id` (or the body's `user`):
 *
 *   EDEN_PROXY_UPSTREAM  the model's base URL with its version path, required (https://api.openai.com/v1,
 *                        https://openrouter.ai/api/v1, https://api.anthropic.com/v1, a local server)
 *   EDEN_URL             Eden's HTTP API, default http://127.0.0.1:8790; EDEN_API_KEY its tenant key
 *   PROXY_PORT, PROXY_HOST  default 8791 on 127.0.0.1
 *   EDEN_PROXY_KEY       a secret callers send as x-eden-proxy-key; required unless PROXY_HOST is loopback
 *   EDEN_PROXY_KEEP_PACKETS=0  insert only the current turn's packets (D336's default keeps earlier ones in place)
 *   EDEN_PROXY_SHADOW=1  report to Eden but inject nothing; one JSON line per request Eden would have changed
 */
import { EdenClient, redactUrls } from "@eden/client";
import { createProxy } from "./proxy";

const upstream = process.env.EDEN_PROXY_UPSTREAM;
if (!upstream || !/^https?:\/\//.test(upstream)) {
  console.error("eden proxy: set EDEN_PROXY_UPSTREAM to the model's base URL (https://api.openai.com/v1)");
  process.exit(2);
}
let upstreamUrl: URL;
try {
  upstreamUrl = new URL(upstream);
} catch {
  console.error(`eden proxy: EDEN_PROXY_UPSTREAM is not a URL: ${redactUrls(upstream)}`);
  process.exit(2);
}
// A base URL with no path is almost always a missing version (`…/v1`): the upstream would get `/chat/completions` and
// answer 404 at the agent's first call, far from this setting (D365).
if (upstreamUrl.pathname.replace(/\/$/, "") === "") {
  console.error(
    `eden proxy: EDEN_PROXY_UPSTREAM=${upstreamUrl.origin} has no path; most providers need their version` +
      ` path (https://api.openai.com/v1, https://openrouter.ai/api/v1). Continuing as given.`,
  );
}
const edenUrl = process.env.EDEN_URL || "http://127.0.0.1:8790";
// For log lines only: a credential or token in either URL never reaches the console (D365).
const shownEden = redactUrls(edenUrl);
const host = process.env.PROXY_HOST || "127.0.0.1";
const proxyKey = process.env.EDEN_PROXY_KEY || undefined;
// The proxy holds the tenant's Eden key and serves whichever user a caller names: beyond this machine, only callers
// with the proxy's own key may (D9).
if (!["127.0.0.1", "localhost", "::1"].includes(host) && (proxyKey?.length ?? 0) < 16) {
  console.error(`eden proxy: PROXY_HOST=${host} needs EDEN_PROXY_KEY (16+ characters) sent as x-eden-proxy-key`);
  process.exit(2);
}
const server = Bun.serve({
  port: Number(process.env.PROXY_PORT || 8791),
  hostname: host,
  // Model calls take seconds to minutes; Bun's 10 s idle default would cut a slow stream.
  idleTimeout: 255,
  // A chat body can carry images, so the cap is wide, but explicit: Bun's 128 MB default parsed and hashed whole.
  maxRequestBodySize: Number(process.env.EDEN_PROXY_MAX_BODY_BYTES || 64 * 1024 * 1024),
  fetch: createProxy({
    upstream,
    edenUrl,
    ...(process.env.EDEN_API_KEY ? { edenApiKey: process.env.EDEN_API_KEY } : {}),
    ...(proxyKey ? { proxyKey } : {}),
    ...(process.env.EDEN_PROXY_KEEP_PACKETS === "0" ? { keepPackets: false } : {}),
    ...(process.env.EDEN_PROXY_SHADOW === "1"
      ? { shadow: true, onShadow: (r) => console.log(JSON.stringify({ shadow: true, ...r })) }
      : {}),
    // One line per swallowed error: route and status, never a request, a key or message text.
    onError: (e) => console.error(`eden proxy: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)),
  }),
});
console.log(
  `eden proxy on http://${server.hostname}:${server.port}/v1 -> ${redactUrls(upstream)} (Eden at ${shownEden})` +
    (process.env.EDEN_PROXY_SHADOW === "1" ? " in shadow mode: nothing is injected" : ""),
);
// One probe of Eden at startup, so a server that is down or a key it refuses shows here once, not as a line per request
// (D365). The proxy runs either way: it fails open, and Eden may start later.
void new EdenClient({
  baseUrl: edenUrl,
  ...(process.env.EDEN_API_KEY ? { apiKey: process.env.EDEN_API_KEY } : {}),
  userId: "proxy-startup",
  sessionId: "probe",
})
  // Seconds, not the client's 800 ms: a server still warming up (its gate, a router's children) is not "unusable".
  .health({ timeoutMs: 5_000 })
  .then((h) =>
    console.error(
      h.ok
        ? `eden proxy: Eden at ${shownEden} accepted ${process.env.EDEN_API_KEY ? "EDEN_API_KEY" : "a key-less request (dev)"}`
        : `eden proxy: Eden not usable yet (${h.error}); requests go upstream without context until it is` +
            (process.env.EDEN_API_KEY ? "" : " (set EDEN_API_KEY if the server has EDEN_API_KEYS)"),
    ),
  );
