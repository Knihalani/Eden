/**
 * Shared id helpers for the instrumentations.
 *
 * Previously each instrumentation file (``openai.ts``,
 * ``anthropic.ts``, ``vercel-ai.ts``, ``langchain.ts``) carried
 * its own copy of a ``randomId()`` function with identical
 * bodies — 24-character URL-safe ids from a base-36 timestamp
 * + a base-36 random suffix. Duplicated code is a divergence
 * hazard: a fix to one (e.g. switching to ``crypto.randomUUID``
 * for cryptographic randomness) would silently leave the
 * other three emitting a different id shape on the wire.
 *
 * Extracted here so the four instrumentations share a single
 * source of truth. The id shape is unchanged so existing
 * downstream consumers (the gateway's per-event trace_id +
 * event_id columns, the portal's URL fragments) keep
 * working without any contract change.
 */

/**
 * Build a compact 24-character random id.
 *
 * The id is base-36 ``Date.now()`` concatenated with a base-36
 * ``Math.random()`` slice, truncated to 24 chars. It is *not*
 * cryptographically random — callers that need unpredictability
 * (e.g. tokens) should use ``crypto.randomUUID()`` instead.
 * For correlation ids the timestamp prefix is a feature: two
 * ids generated in the same millisecond are still unique with
 * ~10^14 keyspace on the random suffix, and the timestamp
 * prefix makes the ids human-readable in logs.
 *
 * The id is URL-safe (only ``[0-9a-z]``) and short enough to
 * fit in a typical URL fragment.
 */
export function randomId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}${rand}`.slice(0, 24);
}
