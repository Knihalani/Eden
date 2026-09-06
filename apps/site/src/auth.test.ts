import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashApiKey, openDb, workspaceForKey, type EdenDb } from "./db";

const ENV_KEYS = ["DATABASE_URL", "VERCEL", "EDEN_DEV"] as const;

describe("workspaceForKey", () => {
  let dir: string;
  let db: EdenDb;
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), "eden-auth-"));
    db = await openDb(join(dir, "test.db"));
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("stores the dev key hashed, never in plaintext", async () => {
    const row = await db.get<{ hash: string }>(`SELECT hash FROM api_key WHERE prefix = ?`, ["eden_dev"]);
    expect(row?.hash).toBe(hashApiKey("eden_dev"));
    expect(row?.hash).not.toBe("eden_dev");
  });

  test("accepts the dev key locally", async () => {
    expect(await workspaceForKey(db, "Bearer eden_dev")).toBe("ws_local");
  });

  test("does not accept a key's prefix as the key itself", async () => {
    // `prefix` is a non-secret row label. Authenticating on it meant anyone who
    // had merely seen a key listed could present that label and be let in.
    await db.run(`INSERT OR IGNORE INTO api_key (prefix, hash, workspace_id) VALUES (?, ?, ?)`, [
      "eden_live_ab12",
      hashApiKey("eden_live_ab12_thesecretpart"),
      "ws_other",
    ]);
    expect(await workspaceForKey(db, "Bearer eden_live_ab12_thesecretpart")).toBe("ws_other");
    // EDEN_DEV=0 removes the permissive local fallback so this asserts the
    // prefix itself is rejected, rather than being absorbed by it.
    process.env.EDEN_DEV = "0";
    expect(await workspaceForKey(db, "Bearer eden_live_ab12")).toBeNull();
  });

  test("seeds no credential into a managed database", async () => {
    // seed() runs on the Neon branch of openDb() too. Seeding there published a
    // known credential to every deployment, and workspaceForKey() consults the
    // table before any environment check — so it authenticated in production.
    process.env.DATABASE_URL = "postgres://example.invalid/db";
    const managedDir = mkdtempSync(join(tmpdir(), "eden-auth-managed-"));
    try {
      // A path forces the SQLite driver while DATABASE_URL still marks the
      // deployment as managed, which is exactly the seeding decision under test.
      const managed = await openDb(join(managedDir, "managed.db"));
      const row = await managed.get<{ hash: string }>(`SELECT hash FROM api_key WHERE prefix = ?`, ["eden_dev"]);
      expect(row).toBeUndefined();
      expect(await workspaceForKey(managed, "Bearer eden_dev")).toBeNull();
    } finally {
      rmSync(managedDir, { recursive: true, force: true });
    }
  });

  test("rejects an unknown key when the dev fallback is off", async () => {
    process.env.EDEN_DEV = "0";
    expect(await workspaceForKey(db, "Bearer eden_nope")).toBeNull();
    expect(await workspaceForKey(db, null)).toBeNull();
  });

  test("migrates a legacy plaintext key to its hash without locking it out", async () => {
    const file = join(dir, "legacy.db");
    const legacy = await openDb(file);
    await legacy.run(`INSERT OR IGNORE INTO api_key (prefix, hash, workspace_id) VALUES (?, ?, ?)`, [
      "eden_legacy",
      "eden_legacy_secret",
      "ws_legacy",
    ]);
    const reopened = await openDb(file);
    const row = await reopened.get<{ hash: string }>(`SELECT hash FROM api_key WHERE prefix = ?`, ["eden_legacy"]);
    expect(row?.hash).toBe(hashApiKey("eden_legacy_secret"));
    expect(await workspaceForKey(reopened, "Bearer eden_legacy_secret")).toBe("ws_legacy");
  });

  test("a row with no stored secret is disabled, not keyed on its prefix", async () => {
    // The migration used to fall back to hashing the prefix when `hash` was
    // NULL. The prefix is the key's *public* label, so that quietly turned a
    // row identifier into a working credential — reopening the hole that
    // removing prefix-matching had just closed.
    process.env.EDEN_DEV = "0";
    const file = join(dir, "nullhash.db");
    const first = await openDb(file);
    await first.run(`INSERT OR IGNORE INTO api_key (prefix, hash, workspace_id) VALUES (?, ?, ?)`, [
      "eden_pubprefix",
      null,
      "ws_victim",
    ]);
    const reopened = await openDb(file);
    const row = await reopened.get<{ hash: string }>(`SELECT hash FROM api_key WHERE prefix = ?`, ["eden_pubprefix"]);
    expect(row?.hash).toBe("disabled");
    expect(row?.hash).not.toBe(hashApiKey("eden_pubprefix"));
    expect(await workspaceForKey(reopened, "Bearer eden_pubprefix")).toBeNull();
  });
});
