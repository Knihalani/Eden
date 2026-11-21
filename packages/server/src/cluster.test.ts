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
async function machine(id: string, processes: number, extra: Record<string, string> = {}) {
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
      ...extra,
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
    // Health rounds as the router's timer runs them, until b has failed twice in a row (a probe racing the exit may
    // still have reached it once).
    let failover = null;
    for (let i = 0; i < 6 && !failover; i++) failover = await cluster.checkHealth();
    if (!failover) throw new Error("b was never dropped");
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

describe("fencing (review of D992)", () => {
  const event = async (base: string, userId: string, session: string) => {
    const res = await fetch(`${base}/v1/events?waitMs=2000`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ userId, sessionId: session, kind: "user_message", text: "Globex renewal with Dana Lee" }),
    });
    await res.arrayBuffer();
    return res.status;
  };

  test("a node frozen and resumed drops its stale users before it is admitted again; a draining node hands its users over", async () => {
    const [a, b, c] = await Promise.all([
      machine("fa", 1),
      machine("fb", 1),
      machine("fc", 1, { EDEN_DRAIN_DELAY_MS: "3000" }),
    ]);
    const cluster = await startCluster({
      config: {
        port: 0,
        host: "127.0.0.1",
        keys: new Map([[KEY, "acme"]]),
        dev: false,
        cluster: { key: CLUSTER_KEY, size: 3 },
      },
      nodes: [
        { id: "fa", url: a.url },
        { id: "fb", url: b.url },
        { id: "fc", url: c.url },
      ],
      healthEveryMs: 0,
      failAfter: 2,
      recoverAfter: 1,
      log: () => {},
    });
    const via = `http://127.0.0.1:${cluster.port}`;
    const users = Array.from({ length: 30 }, (_, i) => `fence-${i}`);
    const three = new OwnerTable(["fa", "fb", "fc"]);
    const onB = users.filter((u) => three.owner(bucketOf("acme", u)) === "fb");
    expect(onB.length).toBeGreaterThan(0);
    for (const u of users) expect(await event(via, u, "s1")).toBe(200);
    expect(await metric(b.url, "eden_users_held")).toBe(onB.length);

    // b freezes (a stall, a partition): dropped; its users are served elsewhere meanwhile.
    b.proc.kill("SIGSTOP");
    let dropped = null;
    for (let i = 0; i < 6 && !dropped; i++) dropped = await cluster.checkHealth();
    expect(dropped?.reason).toContain("fb stopped answering");
    for (const u of onB) expect(await event(via, u, "s2")).toBe(200);
    // b resumes, still holding its users from before: it must not serve them from memory.
    b.proc.kill("SIGCONT");
    let back = null;
    for (let i = 0; i < 6 && !back; i++) back = await cluster.checkHealth();
    expect(back?.reason).toContain("fb is back");
    expect(back?.released).toBe(onB.length); // the interim owners handed them over
    expect(await metric(b.url, "eden_users_held")).toBe(0); // its stale copies were dropped, not served
    for (const u of onB) expect(await event(via, u, "s3")).toBe(200);
    expect(await metric(b.url, "eden_users_held")).toBe(onB.length);
    expect(await metric(b.url, "eden_store_fetched_total")).toBe(onB.length);

    // The fence: a node answers 503 for a user another machine owns, even when called directly.
    const notMine = users.find((u) => three.owner(bucketOf("acme", u)) !== "fa")!;
    expect(await event(a.url, notMine, "s4")).toBe(503);
    expect(await metric(a.url, "eden_cluster_fenced_total")).toBe(1);

    // c is stopped (SIGTERM): its /readyz says draining, so it is a planned leave: it hands its users over first.
    const onC = users.filter((u) => three.owner(bucketOf("acme", u)) === "fc");
    c.proc.kill("SIGTERM");
    await Bun.sleep(200);
    const leave = await cluster.checkHealth();
    expect(leave?.reason).toContain("fc is draining");
    expect(leave?.released).toBe(onC.length);
    for (const u of onC) expect(await event(via, u, "s5")).toBe(200);
    await cluster.stop();
  }, 120_000);
});

test("a node that takes a request and never answers gets the caller a 503 after the forward timeout (R1)", async () => {
  // Ready and told the membership, then silent on the API: a hung process behind an open port.
  const hung = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/readyz") return Response.json({ ready: true });
      if (path === "/internal/cluster") return Response.json({ released: 0, written: 0, pending: 0, ms: 0 });
      return new Promise<Response>(() => {});
    },
  });
  const router = await startCluster({
    config: {
      port: 0,
      host: "127.0.0.1",
      keys: new Map([[KEY, "acme"]]),
      dev: false,
      cluster: { key: CLUSTER_KEY, size: 1 },
    },
    nodes: [{ id: "h", url: `http://127.0.0.1:${hung.port}` }],
    healthEveryMs: 0,
    forwardTimeoutMs: 200,
    log: () => {},
  });
  try {
    const r = await fetch(`http://127.0.0.1:${router.port}/v1/ask`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: "u1", sessionId: "s1", question: "x" }),
    });
    // Without the timeout this request never ends, and the test times out.
    expect(r.status).toBe(503);
  } finally {
    await router.stop();
    hung.stop(true);
  }
});

test("a node's release bound scales with the users it is expected to move (S1-P6)", async () => {
  // Stub nodes record their membership messages; each reports how many users it holds.
  const stub = async (id: string, held: number) => {
    const bodies: { deadlineMs?: number; nodes: string[] }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/readyz") return Response.json({ ready: true });
        if (path === "/internal/cluster") {
          bodies.push((await req.json()) as { deadlineMs?: number; nodes: string[] });
          return Response.json({ released: 0, written: 0, pending: 0, held, ms: 1 });
        }
        return new Response("nf", { status: 404 });
      },
    });
    return { id, url: `http://127.0.0.1:${server.port}`, bodies, server };
  };
  const n1 = await stub("n1", 3_000);
  const n2 = await stub("n2", 3_000);
  const n3 = await stub("n3", 0);
  const router = await startCluster({
    config: {
      port: 0,
      host: "127.0.0.1",
      keys: new Map([[KEY, "acme"]]),
      dev: false,
      cluster: { key: CLUSTER_KEY, size: 3 },
    },
    nodes: [n1, n2].map(({ id, url }) => ({ id, url })),
    healthEveryMs: 0,
    rebalanceMs: 1_000,
    releasePerUserMs: 10,
    log: () => {},
  });
  try {
    // Start: both report 3,000 held. The added node moves about a third of each one's buckets: its bound is the
    // base (nothing reported yet), n1/n2's bounds grow by ~a third of 3,000 x 10 ms — about +10,000.
    await router.setNodes([n1, n2, n3].map(({ id, url }) => ({ id, url })));
    const d1 = n1.bodies.at(-1)!.deadlineMs!;
    const d3 = n3.bodies.at(-1)!.deadlineMs!;
    expect(d1).toBeGreaterThan(9_000);
    expect(d1).toBeLessThan(12_000);
    expect(d3).toBe(1_000);
  } finally {
    await router.stop();
    n1.server.stop(true);
    n2.server.stop(true);
    n3.server.stop(true);
  }
});

test("a follower router serves the leader's published placement (S1-P7)", async () => {
  const objects = new Map<string, Uint8Array>();
  const store = {
    put: async (k: string, b: Uint8Array) => {
      objects.set(k, b);
    },
    get: async (k: string) => objects.get(k) ?? null,
    delete: async (k: string) => {
      objects.delete(k);
    },
    list: async function* () {},
  };
  const stub = async (id: string) => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/readyz") return Response.json({ ready: true });
        if (path === "/internal/cluster") return Response.json({ released: 0, written: 0, pending: 0, ms: 1 });
        return new Response("nf", { status: 404 });
      },
    });
    return { id, url: `http://127.0.0.1:${server.port}`, server };
  };
  const n1 = await stub("n1");
  const n2 = await stub("n2");
  const n3 = await stub("n3");
  const cfg = {
    port: 0,
    host: "127.0.0.1",
    keys: new Map([[KEY, "acme"]]),
    dev: false,
    cluster: { key: CLUSTER_KEY, size: 3 },
  };
  const membership = { store: store as never, key: "frozen/cluster-membership" };
  const leader = await startCluster({
    config: cfg,
    nodes: [n1, n2].map(({ id, url }) => ({ id, url })),
    membership,
    healthEveryMs: 0,
    log: () => {},
  });
  const follower = await startCluster({
    config: { ...cfg },
    nodes: [n1, n2].map(({ id, url }) => ({ id, url })),
    membership,
    follow: { everyMs: 50 },
    healthEveryMs: 0,
    log: () => {},
  });
  try {
    // The first poll inside startCluster adopted the start membership: same owner for every bucket.
    for (const b of [0, 100, 1234, 33333, 65535]) expect(follower.owner(b)).toBe(leader.owner(b));
    expect(
      follower.nodes
        .filter((n) => n.up)
        .map((n) => n.id)
        .sort(),
    ).toEqual(["n1", "n2"]);
    // The leader resizes; the follower sees the published table within a poll — without a probe or a tell.
    await leader.setNodes([n1, n2, n3].map(({ id, url }) => ({ id, url })));
    await Bun.sleep(150);
    for (const b of [0, 100, 1234, 33333, 65535]) expect(follower.owner(b)).toBe(leader.owner(b));
    expect(
      follower.nodes
        .filter((n) => n.up)
        .map((n) => n.id)
        .sort(),
    ).toEqual(["n1", "n2", "n3"]);
    expect(follower.rebalances).toHaveLength(0);
    // A doc not signed with the cluster key — however new — is refused: the store alone cannot steer traffic.
    const owners = [0, 100, 1234, 33333, 65535].map((b) => follower.owner(b));
    objects.set(
      "frozen/cluster-membership",
      new TextEncoder().encode(
        JSON.stringify({
          epoch: Date.now() + 1_000_000,
          live: ["n1"],
          all: ["n1"],
          specs: [{ id: "n1", url: n1.url }],
          moved: [],
          at: Date.now(),
        }),
      ),
    );
    await Bun.sleep(150);
    expect([0, 100, 1234, 33333, 65535].map((b) => follower.owner(b))).toEqual(owners);
    // A signature long enough in characters but not in bytes is refused too, without the poll throwing.
    objects.set(
      "frozen/cluster-membership",
      new TextEncoder().encode(
        JSON.stringify({
          epoch: Date.now() + 2_000_000,
          live: ["n1"],
          all: ["n1"],
          specs: [{ id: "n1", url: n1.url }],
          moved: [],
          at: Date.now(),
          sig: "Ā".repeat(64),
        }),
      ),
    );
    await Bun.sleep(150);
    expect([0, 100, 1234, 33333, 65535].map((b) => follower.owner(b))).toEqual(owners);
    expect(
      follower.nodes
        .filter((n) => n.up)
        .map((n) => n.id)
        .sort(),
    ).toEqual(["n1", "n2", "n3"]);
  } finally {
    await leader.stop();
    await follower.stop();
    n1.server.stop(true);
    n2.server.stop(true);
    n3.server.stop(true);
  }
});
test("health rounds run one at a time: concurrent checkHealth calls share the round (D2049)", async () => {
  // A readyz that takes a beat: two checkHealth calls during it probe the node once, not twice — the interval
  // fires while a round is still in `reset`, and stacking rounds would count fails/oks beside each other.
  let probes = 0;
  const stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/readyz") {
        probes++;
        await Bun.sleep(30);
        return Response.json({ ready: true });
      }
      if (path === "/internal/cluster") return Response.json({ released: 0, written: 0, pending: 0, ms: 0 });
      return new Response("no", { status: 404 });
    },
  });
  const router = await startCluster({
    config: {
      port: 0,
      host: "127.0.0.1",
      keys: new Map([[KEY, "acme"]]),
      dev: false,
      cluster: { key: CLUSTER_KEY, size: 1 },
    },
    nodes: [{ id: "s", url: `http://127.0.0.1:${stub.port}` }],
    healthEveryMs: 0,
    log: () => {},
  });
  try {
    const start = probes;
    const [a, b] = await Promise.all([router.checkHealth(), router.checkHealth()]);
    expect(a).toBe(b); // the same shared round
    expect(probes - start).toBe(1); // one probe, not one per call
  } finally {
    await router.stop();
    stub.stop(true);
  }
});
