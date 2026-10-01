import { handleFetch, envPort } from "./server";

// Loopback unless EDEN_SITE_HOST opts into more (0.0.0.0 for the LAN). A dev host lets every
// caller in without a key (#88). Not HOST: tcsh exports it set to the machine's network name.
const hostname = process.env.EDEN_SITE_HOST?.trim() || "127.0.0.1";
// The socket address goes along: the signup rate limit counts it, not forwarded headers (#91).
const server = Bun.serve({
  port: envPort(process.env.PORT, 8787),
  hostname,
  fetch: (req, srv) => handleFetch(req, srv.requestIP(req)?.address),
});
console.log(`Eden local ${server.url}`);
