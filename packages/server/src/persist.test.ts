/**
 * Persisting frozen users from the server (D425, opt-in): the settings (both or neither, a key that is 32 bytes and
 * never echoed), each process's own directory and the pruning of another process count's, and one server process
 * that writes its live users at SIGTERM, reads them back on the next start and deletes them on `/v1/forget`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { defaultPersistMb, loadConfig, machineMemory } from "./config";
import { childOwns, prunePersistDirs } from "./persist";

const root = mkdtempSync(join(tmpdir(), "eden-persist-server-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const HEX = "a3".repeat(16) + "5c".repeat(16);
const dev = { EDEN_DEV: "1" };

describe("EDEN_PERSIST_* (D425, on by default since D991)", () => {
  const prod = { EDEN_API_KEYS: "acme:0123456789abcdef" };
  test("a production start without a key stops naming EDEN_PERSIST_KEY and EDEN_PERSIST=off; never a generated key", () => {
    expect(() => loadConfig(prod)).toThrow(/EDEN_PERSIST_KEY is not set.*EDEN_PERSIST=off/);
    expect(() => loadConfig({ ...prod, EDEN_PERSIST_FROZEN_DIR: root })).toThrow(/EDEN_PERSIST_KEY is not set/);
    expect(() => loadConfig({ ...prod, EDEN_PERSIST: "on" })).toThrow(/EDEN_PERSIST_KEY is not set/);
    expect(() => loadConfig({ ...prod, EDEN_PERSIST: "yes" })).toThrow(/EDEN_PERSIST must be/);
    // On with the key alone, in EDEN_HOME's frozen directory.
    const on = loadConfig({ ...prod, EDEN_PERSIST_KEY: HEX }).persist!;
    expect(on.dir).toBe(join(process.env.EDEN_HOME!, "frozen"));
    expect(loadConfig({ ...prod, EDEN_PERSIST_KEY: HEX, EDEN_PERSIST_FROZEN_DIR: root }).persist!.dir).toBe(root);
  });

  test("EDEN_PERSIST=off is the operator's explicit choice, and refuses a half-set configuration", () => {
    expect(loadConfig({ ...prod, EDEN_PERSIST: "off" }).persist).toBeNull();
    for (const extra of [{ EDEN_PERSIST_KEY: HEX }, { EDEN_PERSIST_FROZEN_DIR: root }, { EDEN_PERSIST_MAX_MB: "10" }])
      expect(() => loadConfig({ ...prod, EDEN_PERSIST: "off", ...extra })).toThrow(/EDEN_PERSIST=off with/);
  });

  test("dev mode is off unless a persistence variable asks for it, and then needs the key", () => {
    expect(loadConfig(dev).persist).toBeNull();
    expect(() => loadConfig({ ...dev, EDEN_PERSIST_FROZEN_DIR: root })).toThrow(/EDEN_PERSIST_KEY is not set/);
    expect(() => loadConfig({ ...dev, EDEN_PERSIST_MAX_MB: "10" })).toThrow(/EDEN_PERSIST_KEY is not set/);
    expect(loadConfig({ ...dev, EDEN_PERSIST_KEY: HEX }).persist).not.toBeNull();
  });

  test("a cluster node that persists needs the shared store; the cluster router and EDEN_PERSIST=off do not", () => {
    const node = { ...prod, EDEN_PERSIST_KEY: HEX, EDEN_CLUSTER_KEY: "cluster-key-0123456789abcdef" };
    expect(() => loadConfig(node)).toThrow(/needs EDEN_PERSIST_STORE/);
    const store = { EDEN_S3_ACCESS_KEY_ID: "a", EDEN_S3_SECRET_ACCESS_KEY: "secret-0123456789" };
    expect(loadConfig({ ...node, ...store, EDEN_PERSIST_STORE: "s3://eden-frozen/" }).persist!.store!.buckets).toEqual([
      "eden-frozen",
    ]);
    expect(
      loadConfig({ ...prod, EDEN_PERSIST: "off", EDEN_CLUSTER_KEY: node.EDEN_CLUSTER_KEY }).cluster!.key,
    ).not.toBeNull();
    expect(
      loadConfig({ ...prod, EDEN_NODES: "a=http://h:1", EDEN_CLUSTER_KEY: node.EDEN_CLUSTER_KEY }).persist,
    ).toBeNull();
    // Paths come from the env given, not only the process's (review of D992).
    const home = join(root, "own-home");
    expect(loadConfig({ ...prod, EDEN_PERSIST: "off", EDEN_HOME: home }).sourceMapPath).toBe(
      join(home, "source-map.db"),
    );
    expect(readdirSync(root)).toContain("own-home"); // created, as edenHome() creates the process's
  });

  test("the default cap is the machine's memory (a cgroup limit lowers it), at least 4,096 MB", () => {
    const GB = 1_073_741_824;
    const env = { ...prod, EDEN_PERSIST_KEY: HEX };
    expect(loadConfig(env, 2, 12 * GB).persist!.maxBytes).toBe(12 * GB);
    expect(loadConfig(env, 2, 2 * GB).persist!.maxBytes).toBe(4 * GB);
    expect(defaultPersistMb(NaN)).toBe(4_096);
    const files: Record<string, string> = { "/sys/fs/cgroup/memory.max": "6442450944\n" };
    expect(machineMemory((p) => files[p] ?? null, 16 * GB)).toBe(6 * GB);
    expect(machineMemory((p) => (p.endsWith("memory.max") ? "max\n" : null), 16 * GB)).toBe(16 * GB);
    // cgroup v1's "no limit" is a huge number, never above the machine's total.
    const v1 = (p: string) => (p.endsWith("limit_in_bytes") ? "9223372036854771712" : null);
    expect(machineMemory(v1, 16 * GB)).toBe(16 * GB);
  });

  test("the key is 32 bytes (hex or base64), never a placeholder, and no message or log shows it", () => {
    const base64 = Buffer.from(HEX, "hex").toString("base64");
    for (const k of [HEX, base64]) {
      const c = loadConfig({ ...dev, EDEN_PERSIST_FROZEN_DIR: root, EDEN_PERSIST_KEY: k });
      expect(Buffer.from(c.persist!.key.bytes()).toString("hex")).toBe(HEX);
      expect(JSON.stringify(c)).not.toContain(HEX.slice(0, 16));
      expect(inspect(c, { depth: 5 })).not.toContain("a3a3");
      expect(String(c.persist!.key)).toBe("[redacted]");
    }
    const bad = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde"; // 63 digits
    for (const k of [bad, "0".repeat(64), "short"]) {
      let message = "";
      try {
        loadConfig({ ...dev, EDEN_PERSIST_FROZEN_DIR: root, EDEN_PERSIST_KEY: k });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/EDEN_PERSIST_KEY must be 32 random bytes/);
      expect(message).not.toContain(k);
    }
  });

  test("the cap is the whole directory's; a router child holds 1/N of it", () => {
    const env = { ...dev, EDEN_PERSIST_FROZEN_DIR: root, EDEN_PERSIST_KEY: HEX, EDEN_PERSIST_MAX_MB: "100" };
    expect(loadConfig(env).persist!.maxBytes).toBe(100 * 1_048_576);
    expect(loadConfig({ ...env, EDEN_ROUTER_CHILD: "1/4" }).persist!.maxBytes).toBe(25 * 1_048_576);
  });

  test("one directory per machine (D992): the old per-process directories are deleted, anything else is left", () => {
    const base = join(root, "prune");
    for (const d of ["0-of-2", "1-of-2", "0-of-3", "notes"]) mkdirSync(join(base, d), { recursive: true });
    expect(prunePersistDirs(base)).toBe(3);
    expect(readdirSync(base).sort()).toEqual(["notes"]);
    // Children own disjoint bucket sets covering every bucket.
    const owners = [childOwns(0, 3), childOwns(1, 3), childOwns(2, 3)];
    for (const b of [0, 1, 77, 4_096, 65_535]) expect(owners.filter((o) => o(b)).length).toBe(1);
  });
});

/** Starts one server process; resolves with its port and what it logged. */
async function start(env: Record<string, string>) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
    env: { ...process.env, ...env, PORT: "0", EDEN_PROCESSES: "1", EDEN_DEV: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = new TextDecoder();
  let out = "";
  for await (const chunk of proc.stdout) {
    out += text.decode(chunk);
    if (out.includes("listening on")) break;
  }
  const port = Number(/127\.0\.0\.1:(\d+)/.exec(out)?.[1]);
  const stop = async () => {
    proc.kill("SIGTERM");
    const killer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    await proc.exited;
    clearTimeout(killer);
    return new Response(proc.stderr).text();
  };
  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { out, stop, post };
}

test("a server writes live users at SIGTERM, reads them back after a restart, and forget deletes them", async () => {
  const home = join(root, "home");
  const dir = join(root, "frozen");
  mkdirSync(home, { recursive: true });
  const sources = join(root, "sources.json");
  writeFileSync(
    sources,
    JSON.stringify({
      sources: [
        {
          id: "crm",
          description: "deals",
          docs: [{ ref: "d1", title: "Globex renewal", text: "Dana Lee wants 12% off" }],
        },
      ],
    }),
  );
  const env = { EDEN_HOME: home, EDEN_SOURCES_FILE: sources, EDEN_PERSIST_FROZEN_DIR: dir, EDEN_PERSIST_KEY: HEX };
  const blobs = () => readdirSync(dir).filter((f) => f.endsWith(".blob"));

  const a = await start(env);
  expect(a.out).toContain("frozen users persisted, encrypted (0 on disk");
  const ask = (await (
    await a.post("/v1/ask", { userId: "u1", sessionId: "s1", question: "What does Dana Lee want?" })
  ).json()) as {
    citations: { itemId: string }[];
  };
  expect(ask.citations[0]?.itemId).toBe("crm:d1");
  expect(await a.stop()).toContain("persisted 1 live users at shutdown");
  expect(blobs().length).toBe(1);

  const b = await start(env);
  expect(b.out).toContain("(1 on disk");
  expect((await b.post("/v1/forget", { userId: "u1" })).status).toBe(200);
  expect(blobs()).toEqual([]);
  await b.stop();
}, 30_000);

/** A static sources file with one document, so a user who asks holds an item (an empty user is not written). */
function oneDoc(name: string): string {
  const path = join(root, `${name}.json`);
  const doc = { ref: "d1", title: "Globex renewal", text: "Dana Lee wants 12% off" };
  writeFileSync(path, JSON.stringify({ sources: [{ id: "crm", description: "deals", docs: [doc] }] }));
  return path;
}

test("a wrong key stops the start and deletes nothing; EDEN_PERSIST_DISCARD=1 starts and says so (D1071)", async () => {
  const home = join(root, "home-key");
  const dir = join(root, "frozen-key");
  mkdirSync(home, { recursive: true });
  const env = {
    EDEN_HOME: home,
    EDEN_SOURCES_FILE: oneDoc(dir.slice(root.length + 1)),
    EDEN_PERSIST_FROZEN_DIR: dir,
    EDEN_PERSIST_KEY: HEX,
  };
  const blobs = () => readdirSync(dir).filter((f) => f.endsWith(".blob"));
  const a = await start(env);
  await a.post("/v1/ask", { userId: "u1", sessionId: "s1", question: "What does Dana Lee want?" });
  await a.post("/v1/ask", { userId: "u2", sessionId: "s1", question: "What does Dana Lee want?" });
  expect(await a.stop()).toContain("persisted 2 live users at shutdown");
  expect(blobs().length).toBe(2);

  const WRONG = "5c".repeat(16) + "a3".repeat(16);
  const refused = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
    env: { ...process.env, ...env, EDEN_PERSIST_KEY: WRONG, PORT: "0", EDEN_PROCESSES: "1", EDEN_DEV: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await refused.exited).toBe(2);
  const said = await new Response(refused.stderr).text();
  expect(said).toContain("EDEN_PERSIST_KEY opens none of the 2 persisted users");
  expect(said).toContain("EDEN_PERSIST_DISCARD=1");
  expect(said).not.toContain(WRONG);
  expect(blobs().length).toBe(2);

  const b = await start({ ...env, EDEN_PERSIST_KEY: WRONG, EDEN_PERSIST_DISCARD: "1" });
  expect(b.out).toContain("listening on");
  expect(blobs()).toEqual([]);
  expect(await b.stop()).toContain("EDEN_PERSIST_DISCARD=1: discarded 2 persisted users written with another key");
}, 30_000);

test("a problem found on a user's first read is logged at shutdown, not left to the minute's timer (R1)", async () => {
  const home = join(root, "home-flush");
  const dir = join(root, "frozen-flush");
  mkdirSync(home, { recursive: true });
  const env = {
    EDEN_HOME: home,
    EDEN_SOURCES_FILE: oneDoc(dir.slice(root.length + 1)),
    EDEN_PERSIST_FROZEN_DIR: dir,
    EDEN_PERSIST_KEY: HEX,
  };
  const a = await start(env);
  await a.post("/v1/ask", { userId: "u1", sessionId: "s1", question: "What does Dana Lee want?" });
  await a.stop();
  const [blob] = readdirSync(dir).filter((f) => f.endsWith(".blob"));
  // A flipped ciphertext byte: the header passes at open, the read fails its tag.
  const bytes = readFileSync(join(dir, blob!));
  bytes[bytes.length - 40] = bytes[bytes.length - 40]! ^ 0xff;
  writeFileSync(join(dir, blob!), bytes);
  const b = await start(env);
  await b.post("/v1/ask", { userId: "u1", sessionId: "s1", question: "What does Dana Lee want?" });
  expect(await b.stop()).toContain("frozen users on disk: 1 discarded (corrupt)");
}, 30_000);

test("EDEN_PERSIST_DISCARD is 1 or unset, and is refused beside EDEN_PERSIST=off (D1071)", () => {
  const prod = { EDEN_API_KEYS: "acme:k_acme_0123456789abcdef", EDEN_HOME: root };
  expect(loadConfig({ ...prod, EDEN_PERSIST_KEY: HEX, EDEN_PERSIST_DISCARD: "1" }).persist!.discard).toBe(true);
  expect(loadConfig({ ...prod, EDEN_PERSIST_KEY: HEX }).persist!.discard).toBe(false);
  expect(() => loadConfig({ ...prod, EDEN_PERSIST_KEY: HEX, EDEN_PERSIST_DISCARD: "yes" })).toThrow(
    /EDEN_PERSIST_DISCARD must be 1 or unset/,
  );
  expect(() => loadConfig({ ...prod, EDEN_PERSIST: "off", EDEN_PERSIST_DISCARD: "1" })).toThrow(/_DISCARD/);
});
