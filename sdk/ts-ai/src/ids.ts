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


/**
 * Error-class extraction shared by every instrumentation.
 *
 * Mirrors the Python SDK's ``repr(exc)`` flow: the Python
 * instrumentations always store BOTH the class name (e.g.
 * ``"TypeError"``) AND the message (e.g. ``"boom"``) so
 * the portal's trace-detail view can show a human-readable
 * ``"TypeError: boom"`` row. The TS instrumentations
 * previously only stored the class name and dropped the
 * message, so a thrown ``new Error("rate limit exceeded")``
 * landed on the wire as just ``error_type: "Error"`` with
 * no message. Callers couldn't tell two distinct ``Error``
 * throws apart. The shared helper normalises the shape so
 * every TS source format (OpenAI, Anthropic, LangChain,
 * Vercel AI) emits ``error_type`` + ``error_message`` the
 * same way the Python SDK does.
 */
export function errorClass(err: unknown): string {
  if (err instanceof Error) return err.constructor.name;
  if (err === null) return "null";
  if (err === undefined) return "undefined";
  if (typeof err === "string") return "Error";
  if (typeof err === "number" || typeof err === "boolean")
    return typeof err === "number" ? "Number" : "Boolean";
  return Object.prototype.toString.call(err).slice(8, -1) || "Object";
}

export function errorMessage(err: unknown): string | undefined {
  if (err === null || err === undefined) return undefined;
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean")
    return String(err);
  // Objects: best-effort serialise. A ``JSON.stringify``
  // failure (e.g. circular ref) falls back to the
  // constructor-tag so the wire always has SOMETHING
  // readable; ``null`` is never emitted (the field is
  // omitted instead, matching the Python SDK's
  // ``error=repr(exc)`` which only sets the field when
  // an exception was actually caught).
  try {
    const json = JSON.stringify(err);
    return json === undefined ? undefined : json;
  } catch {
    return undefined;
  }
}
