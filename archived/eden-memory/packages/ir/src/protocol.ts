/**
 * Wire-protocol version for Eden client/server communication.
 *
 * One number, one place. Clients (CLI hooks/drain/import, wrap proxy, both
 * SDKs) send it as `X-Eden-Version`; servers compare and refuse a MISMATCH
 * with 426 while treating absence as "old client, proceed" so upgrades never
 * brick a working install. Every response also carries the header, which lets
 * clients warn on downgrade skew before something breaks.
 *
 * This constant existing at all closes the failure class where the hook flush
 * posted a single-trace body while import posted `{traces:[…]}` to the same
 * endpoint with nothing anywhere recording that the contract had two shapes
 * (the server happens to accept both — now the version says which protocol a
 * client speaks, and a bump means the server can require it).
 */
export const EDEN_PROTOCOL_VERSION = 1;

export const PROTOCOL_HEADER = "x-eden-version";

/** Headers every Eden client should attach to control-plane requests. */
export function protocolHeaders(): Record<string, string> {
  return { [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION) };
}

export type ProtocolGate = { ok: true } | { ok: false; status: 426; reason: string };

/** Optional response header when a known-older integer client is still allowed. */
export const PROTOCOL_SKEW_HEADER = "x-eden-protocol-skew";

/**
 * Server-side gate on an incoming protocol version.
 *
 * Absent header → allow (legacy clients keep working). Matching → allow.
 * Mismatched → refuse with 426 and a message that names both versions, so a
 * skewed CLI tells its user exactly what happened instead of failing obscurely
 * downstream.
 *
 * Unknown *future* integers stay 426. Absent / malformed still allow. A
 * known-older integer (1 ≤ n < EDEN_PROTOCOL_VERSION) currently also 426s
 * through this gate — use {@link protocolSkewHeader} if a caller wants to
 * *warn* on that case without relaxing the future-mismatch refuse.
 */
export function protocolCheck(version: string | null | undefined): ProtocolGate {
  if (!version) return { ok: true };
  const n = Number(version);
  if (!Number.isFinite(n)) return { ok: true }; // not ours to judge
  if (n === EDEN_PROTOCOL_VERSION) return { ok: true };
  return {
    ok: false,
    status: 426,
    reason:
      `Eden protocol mismatch: client speaks ${n}, server speaks ${EDEN_PROTOCOL_VERSION}. ` +
      "Upgrade the older side (`npm i -g @kaiavn/eden` / redeploy) so both speak the same protocol.",
  };
}

/**
 * Warn header for a *known-older* integer client. Returns undefined for
 * absent, malformed, current, and unknown-future versions — those stay on
 * {@link protocolCheck} (allow / 426). Never used to allow a future version.
 */
export function protocolSkewHeader(version: string | null | undefined): string | undefined {
  if (!version) return undefined;
  const n = Number(version);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (n >= 1 && n < EDEN_PROTOCOL_VERSION) {
    return `client=${n}; server=${EDEN_PROTOCOL_VERSION}`;
  }
  return undefined;
}
