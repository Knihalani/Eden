import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { edenHome, ensureHome } from "./home";

/** The header every hookd client sends (#85). */
export const HOOKD_KEY_HEADER = "x-eden-hookd-key";

/**
 * hookd's per-install secret, next to config.json in the 0700 Eden home. The file is one header
 * line, `x-eden-hookd-key: <hex>`, so a hook command sends it with `curl -H @file` and the key
 * never appears in a process list. It is not in config.json: `eden setup` and `eden login` rewrite
 * that file whole, and a memory-only install has none.
 */
export function hookdKeyPath(): string {
  return join(edenHome(), "hookd.key");
}

/** The key, or null when the file is missing, malformed, not this user's, or open to others. */
export function readHookdKey(): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(hookdKeyPath(), "r");
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null;
    const m = /^x-eden-hookd-key:[ \t]*([0-9a-f]{64})\s*$/.exec(readFileSync(fd, "utf8"));
    return m ? m[1]! : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Returns the key, creating it (0600) when there is none. An existing file is never replaced, so
 * two hookd starts agree on one key. Throws when the file exists but readHookdKey refuses it.
 */
export function ensureHookdKey(): string {
  const existing = readHookdKey();
  if (existing) return existing;
  ensureHome();
  const path = hookdKeyPath();
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    rmQuietly(tmp);
    writeFileSync(tmp, `${HOOKD_KEY_HEADER}: ${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    linkSync(tmp, path);
  } catch (err) {
    // EEXIST: another start linked its key first. Its key stands.
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  } finally {
    rmQuietly(tmp);
  }
  const key = readHookdKey();
  if (!key) throw new Error(`${path} is not a 0600 hookd key owned by this user`);
  return key;
}

/** Whether a request's header carries the current key. */
export function hookdKeyMatches(got: string | null): boolean {
  const want = readHookdKey();
  if (!want || !got) return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(want, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function rmQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}
