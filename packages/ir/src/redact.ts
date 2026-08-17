const SECRET_KEY =
  /^(api[_-]?key|apikey|password|passwd|secret|secret[_-]?key|token|authorization|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|bearer|session|cookie|set-cookie|x-api-key|x-auth-token|jwt|credentials|auth)$/i;

const SECRET_INLINE =
  /\b(Bearer\s+[A-Za-z0-9._\-+=/]+)|\b(sk-[A-Za-z0-9]{8,})|\b(ghp_[A-Za-z0-9]{20,})|\b(gho_[A-Za-z0-9]{20,})|\b(github_pat_[A-Za-z0-9_]{20,})|\b(xox[baprs]-[A-Za-z0-9-]{10,})|\b(api[_-]?key\s*[=:]\s*\S+)|\b(password\s*[=:]\s*\S+)/gi;

/** Sentinel substituted for anything that looked like a credential. */
export const REDACTED = "[REDACTED]";
/** Sentinel substituted for a back-edge to an ancestor (a genuine cycle). */
export const CYCLE = "[CYCLE]";

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

export function redactString(s: string): string {
  if (!/[Bb]earer|[Pp]assword|[Aa]pi[_-]?key|\bsk-|\bghp_|\bgho_|\bgithub_pat_|\bxox[baprs]-/.test(s)) return s;
  SECRET_INLINE.lastIndex = 0;
  return s.replace(SECRET_INLINE, REDACTED);
}

/**
 * True if `value` contains the redaction sentinel at any depth.
 *
 * A slot whose witnessed values all agree looks bindable as a literal, but if
 * that agreed-upon value is (or contains) a redacted credential, baking it in
 * would compile a program that ships the string "[REDACTED]" to a live API.
 * Such a slot has to be refused, not bound.
 */
export function containsRedaction(value: unknown, stack?: WeakSet<object>): boolean {
  if (typeof value === "string") return value.includes(REDACTED);
  if (value == null || typeof value !== "object") return false;
  const path = stack ?? new WeakSet<object>();
  if (path.has(value)) return false;
  path.add(value);
  try {
    if (Array.isArray(value)) return value.some((v) => containsRedaction(v, path));
    return Object.values(value as Record<string, unknown>).some((v) => containsRedaction(v, path));
  } finally {
    path.delete(value);
  }
}

// `stack` tracks only the current traversal path. A back-edge to an ancestor is
// a real cycle and is cut; a value shared between sibling branches is not, and
// must still be redacted in full. Marking every visited object would replace
// legitimate repeated data with the "[REDACTED]" sentinel — silent corruption
// that then gets baked into compiled programs as a literal.
export function redact(value: unknown, stack?: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (value == null || typeof value !== "object") return value;
  const path = stack ?? new WeakSet<object>();
  if (path.has(value)) return CYCLE;
  path.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redact(v, path));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? REDACTED : redact(v, path);
    }
    return out;
  } finally {
    path.delete(value);
  }
}

export function containsSecret(value: unknown, seen?: WeakSet<object>): boolean {
  if (typeof value === "string") {
    return /Bearer\s+[A-Za-z0-9._\-+=/]+|\bsk-[A-Za-z0-9]{8,}|\bghp_[A-Za-z0-9]{20,}|\b(api[_-]?key|password)\s*[=:]\s*\S+/i.test(
      value,
    );
  }
  if (value == null || typeof value !== "object") return false;
  const path = seen ?? new WeakSet<object>();
  if (path.has(value)) return false;
  path.add(value);
  try {
    if (Array.isArray(value)) return value.some((v) => containsSecret(v, path));
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k)) return true;
      if (containsSecret(v, path)) return true;
    }
    return false;
  } finally {
    path.delete(value);
  }
}
