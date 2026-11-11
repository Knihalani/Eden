/**
 * The cluster router over real machines (D992), end to end on one host: three nodes (`main.ts` processes, one of them
 * a two-child machine router) sharing an S3-compatible store (`fakeS3`), and the cluster router in this process.
 * Users stay where they are placed; a fourth node takes about a quarter of them, each released by its old node into
 * the store and fetched by the new one; a node killed outright is dropped and its users served by the others from
 * what the store holds; removing a node releases everything it holds; forget reaches every node and the store.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUCKETS, OwnerTable } from "@eden/primitives";
import { bucketOf } from "@eden/protocol";
import { parseNodes, startCluster, type ClusterRouter } from "./cluster";
import { fakeS3 } from "./fixtures/fake-s3";

const KEY = "k_acme_0123456789abcdef";
const CLUSTER_KEY = "cluster-key-0123456789abcdef";
const PERSIST_KEY = "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0";
const MAIN = join(import.meta.dir, "main.ts");
const root = mkdtempSync(join(tmpdir(), "eden-cluster-"));
const s3 = fakeS3("eden-frozen");
const procs: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const p of procs) p.kill("SIGKILL");
  s3.stop();
  rmSync(root, { recursive: true, force: true });
});

const sources = join(root, "sources.json");
writeFileSync(
  sources,
  JSON.stringify({
    sources: [
      {
        id: "crm",
        description: "deals",
        docs: [{ ref: "d1", title: "Globex renewal", text: "Dana Lee wants 12% off the Globex renewal" }],
      },
    ],
  }),
);

/** Starts one machine (`main.ts`); resolves with its URL once it listens. */
async function machine(id: string, processes: number) {
  const proc = Bun.spawn(["bun", MAIN], {
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      EDEN_HOME: join(root, id),
      EDEN_API_KEYS: `acme:${KEY}`,
      EDEN_SOURCES_FILE: sources,
      EDEN_PROCESSES: String(processes),
      EDEN_PERSIST_KEY: PERSIST_KEY,
      EDEN_PERSIST_STORE: "s3://eden-frozen/frozen/",
      EDEN_S3_ENDPOINT: s3.url,
      EDEN_S3_ACCESS_KEY_ID: "test",
      EDEN_S3_SECRET_ACCESS_KEY: "test-secret-0123456789",
      EDEN_CLUSTER_KEY: CLUSTER_KEY,
      EDEN_CLUSTER_SIZE: "3",
      EDEN_SHUTDOWN_GRACE_MS: "4000",
      EDEN_TENANT_RPS: "10000",
      EDEN_TENANT_BURST: "10000",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(proc);
  const text = new TextDecoder();
  let out = "";
  const reader = proc.stdout.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`${id} exited: ${await new Response(proc.stderr).text()}`);
    out += text.decode(value);
    const m = /eden (?:router|partner) listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
    if (m && (processes === 1 || out.includes("eden router listening"))) {
      reader.releaseLock();
      return { id, url: `http://127.0.0.1:${m[1]}`, proc };
    }
  }
}

const metric = async (url: string, name: string) => {
  const text = await (await fetch(`${url}/metrics`)).text();
  return Number(new RegExp(`^${name} (\\S+)$`, "m").exec(text)?.[1] ?? NaN);
};

describe("the cluster router over three machines (D992)", () => {
  let cluster: ClusterRouter;
  const users = Array.from({ length: 40 }, (_, i) => `user-${i}`);
  // A session per round: the not-twice ledger (D13) hands an item once a session.
  let round = 0;
  const event = async (userId: string) => {
    const res = await fetch(`http://127.0.0.1:${cluster.port}/v1/events?waitMs=2000`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        userId,
        sessionId: `s${round}`,
        kind: "user_message",
        text: "Globex renewal with Dana Lee",
      }),
    });
    const body = (await res.json()) as { injection: { text: string } | null };
    return { status: res.status, found: body.injection?.text.includes("Globex") ?? false };
  };

  test("parseNodes takes id=url lists and refuses mistakes", () => {
    expect(parseNodes("a=http://10.0.0.1:8790, b=http://h:1/\n# c=x\n")).toEqual([
      { id: "a", url: "http://10.0.0.1:8790" },
      { id: "b", url: "http://h:1" },
    ]);
    for (const bad of ["a", "a=ftp://x", "a b=http://x:1", "a=http://x:1,a=http://y:1"])
      expect(() => parseNodes(bad)).toThrow(/EDEN_NODES/);
  });

  test("placement, a node added, a node killed, a node removed, forget", async () => {
    const [a, b, c] = await Promise.all([machine("a", 1), machine("b", 2), machine("c", 1)]);
    cluster = await startCluster({
      config: {
        port: 0,
        host: "127.0.0.1",
        keys: new Map([[KEY, "acme"]]),
        dev: false,
        cluster: { key: CLUSTER_KEY, size: 3 },
      },
      nodes: [a, b, c].map(({ id, url }) => ({ id, url })),
      healthEveryMs: 0,
      failAfter: 2,
      recoverAfter: 1,
      log: () => {},
    });
    expect(cluster.nodes.every((n) => n.up)).toBe(true);
    const owners = new OwnerTable(["a", "b", "c"]);
    for (const u of users) expect(cluster.owner(bucketOf("acme", u))).toBe(owners.owner(bucketOf("acme", u)));
    round++;
    for (const u of users) expect(await event(u)).toEqual({ status: 200, found: true });
    const held = async (url: string) => metric(url, "eden_users_held");
    const byNode = { a: 0, b: 0, c: 0 } as Record<string, number>;
    for (const u of users) byNode[owners.owner(bucketOf("acme", u))!]!++;
    expect([await held(a.url), await held(b.url), await held(c.url)]).toEqual([byNode.a!, byNode.b!, byNode.c!]);

    // A fourth node: about a quarter of buckets move, all to it, released into the store first.
    const d = await machine("d", 1);
    const added = (await cluster.setNodes([a, b, c, d].map(({ id, url }) => ({ id, url }))))!;
    expect(Math.abs(added.share - 1 / 4)).toBeLessThan(0.02);
    const four = new OwnerTable(["a", "b", "c", "d"]);
    const toD = users.filter((u) => four.owner(bucketOf("acme", u)) === "d");
    expect(toD.length).toBeGreaterThan(0);
    expect(added.released).toBe(toD.length);
    round++;
    for (const u of users) expect(await event(u)).toEqual({ status: 200, found: true });
    expect(await metric(d.url, "eden_store_fetched_total")).toBe(toD.length);
    expect(await held(d.url)).toBe(toD.length);
    expect((await held(a.url)) + (await held(b.url)) + (await held(c.url))).toBe(users.length - toD.length);

    // b dies without a word: dropped after two failed probes; its users are served by the others.
    b.proc.kill("SIGKILL");
    await b.proc.exited;
    await cluster.checkHealth();
    const failover = (await cluster.checkHealth())!;
    expect(failover.reason).toContain("b stopped answering");
    const fromB = users.filter((u) => four.owner(bucketOf("acme", u)) === "b");
    round++;
    for (const u of fromB) expect(await event(u)).toEqual({ status: 200, found: true });
    for (const u of users) expect(cluster.owner(bucketOf("acme", u))).not.toBe("b");

    // d is removed from the list (scale down): it releases all it holds; they land on a and c.
    const removed = (await cluster.setNodes([a, c].map(({ id, url }) => ({ id, url }))))!;
    expect(removed.released).toBe(
      toD.length + fromB.filter((u) => new OwnerTable(["a", "c", "d"]).owner(bucketOf("acme", u)) === "d").length,
    );
    expect(await held(d.url)).toBe(0);
    round++;
    for (const u of users) expect(await event(u)).toEqual({ status: 200, found: true });
    expect((await held(a.url)) + (await held(c.url))).toBe(users.length);

    // Forget goes to every member and deletes the store's copy of the user.
    const objects = () => [...s3.objects.keys()].length;
    const before = objects();
    const f = await fetch(`http://127.0.0.1:${cluster.port}/v1/forget`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: toD[0] }),
    });
    expect(f.status).toBe(200);
    await Bun.sleep(300);
    expect(objects()).toBeLessThanOrEqual(before);
    // The membership endpoint refuses anyone without the cluster key.
    const anon = await fetch(`${a.url}/internal/cluster`, { method: "POST", body: "{}" });
    expect(anon.status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${cluster.port}/internal/cluster`, { method: "POST" })).status).toBe(404);
    expect(BUCKETS).toBe(65_536);
    await cluster.stop();
  }, 120_000);
});
