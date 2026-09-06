import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { destroyEgressAgents, pinnedFetch } from "./ssrf";

afterEach(() => destroyEgressAgents());

function listen(opts: {
  onRequest?: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void;
  onConnection?: (socket: Socket) => void;
}): Promise<{ srv: Server; port: number }> {
  const srv = createServer(opts.onRequest ?? ((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  }));
  if (opts.onConnection) srv.on("connection", opts.onConnection);
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: (srv.address() as { port: number }).port })),
  );
}

function p50(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function sequentialGets(fetchImpl: typeof fetch, origin: string, n: number): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const res = await fetchImpl(`${origin}/s/${i}`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    times.push(performance.now() - t0);
  }
  return times;
}

describe("egress connection amortization", () => {
  test("reuses one TCP connection across a long-etl-class stretch of GETs", async () => {
    const n = 32;
    let connections = 0;
    const { srv, port } = await listen({
      onConnection: () => {
        connections++;
      },
    });
    try {
      const fetchImpl = pinnedFetch([{ address: "127.0.0.1", family: 4 }]);
      const times = await sequentialGets(fetchImpl, `http://example.com:${port}`, n);
      expect(connections).toBeLessThanOrEqual(2);
      expect(connections).toBeGreaterThan(0);
      console.log(
        `egress-pool connections: pooled ${connections} for ${n} GETs; localhost p50=${p50(times).toFixed(3)}ms sum=${times.reduce((a, b) => a + b, 0).toFixed(1)}ms`,
      );
    } finally {
      destroyEgressAgents();
      srv.close();
    }
  });

  test("p50 wall drops vs agent:false on long-etl-class sequential GETs", async () => {
    // Localhost handshake is tens of microseconds and p50 is noise. Charge a
    // short delay on the first response of each TCP connection — the cost a
    // WAN hop would pay once per socket. Reused sockets never see it again.
    const n = 32;
    const SETUP_MS = 8;

    const measure = async (pooled: boolean) => {
      let connections = 0;
      const charged = new WeakSet<Socket>();
      const { srv, port } = await listen({
        onConnection: () => {
          connections++;
        },
        onRequest: (req, res) => {
          const first = !charged.has(req.socket);
          if (first) charged.add(req.socket);
          const send = () => {
            res.writeHead(200);
            res.end("ok");
          };
          if (first) setTimeout(send, SETUP_MS);
          else send();
        },
      });
      try {
        const fetchImpl = pinnedFetch([{ address: "127.0.0.1", family: 4 }], { pooled });
        const times = await sequentialGets(fetchImpl, `http://example.com:${port}`, n);
        return { connections, times, p50: p50(times), sum: times.reduce((a, b) => a + b, 0) };
      } finally {
        destroyEgressAgents();
        srv.close();
      }
    };

    const pooled = await measure(true);
    const unpooled = await measure(false);

    console.log(
      `egress-pool p50: pooled=${pooled.p50.toFixed(3)}ms (${pooled.connections} conns, sum=${pooled.sum.toFixed(1)}ms) ` +
        `unpooled=${unpooled.p50.toFixed(3)}ms (${unpooled.connections} conns, sum=${unpooled.sum.toFixed(1)}ms) ` +
        `n=${n}`,
    );

    expect(pooled.connections).toBeLessThanOrEqual(2);
    expect(unpooled.connections).toBe(n);
    expect(pooled.p50).toBeLessThan(unpooled.p50);
    expect(pooled.sum).toBeLessThan(unpooled.sum);
  });

  test("pooling does not un-pin: a hostname-warmed socket is not reused for a different pin", async () => {
    let hits = 0;
    const { srv, port } = await listen({
      onRequest: (_req, res) => {
        hits++;
        res.writeHead(200);
        res.end("ok");
      },
    });
    try {
      const pinnedLocal = pinnedFetch([{ address: "127.0.0.1", family: 4 }]);
      for (let i = 0; i < 8; i++) {
        const res = await pinnedLocal(`http://example.com:${port}/warm/${i}`);
        expect(res.status).toBe(200);
        await res.arrayBuffer();
      }
      expect(hits).toBe(8);

      // TEST-NET-1: a pin that is not the local server. Hostname-keyed reuse
      // would skip lookup and hit the warmed socket (hits would become 9).
      const pinnedElsewhere = pinnedFetch([{ address: "192.0.2.1", family: 4 }]);
      await expect(
        pinnedElsewhere(`http://example.com:${port}/unpin`, { signal: AbortSignal.timeout(500) }),
      ).rejects.toThrow();
      expect(hits).toBe(8);
    } finally {
      destroyEgressAgents();
      srv.close();
    }
  });

  test("EDEN_EGRESS_POOL=0 is the unpooled Wave-10 path", async () => {
    const n = 8;
    let connections = 0;
    const { srv, port } = await listen({
      onConnection: () => {
        connections++;
      },
    });
    const prev = process.env.EDEN_EGRESS_POOL;
    process.env.EDEN_EGRESS_POOL = "0";
    try {
      const fetchImpl = pinnedFetch([{ address: "127.0.0.1", family: 4 }]);
      await sequentialGets(fetchImpl, `http://example.com:${port}`, n);
      expect(connections).toBe(n);
    } finally {
      if (prev === undefined) delete process.env.EDEN_EGRESS_POOL;
      else process.env.EDEN_EGRESS_POOL = prev;
      destroyEgressAgents();
      srv.close();
    }
  });

  test("api.github.com pinned to 127.0.0.1 is still refused after the pool has been used", async () => {
    const { srv, port } = await listen({});
    try {
      const f = pinnedFetch([{ address: "127.0.0.1", family: 4 }]);
      const local = await f(`http://example.com:${port}/x`);
      expect(local.status).toBe(200);
      await local.arrayBuffer();
      await expect(f("https://api.github.com/")).rejects.toThrow();
    } finally {
      destroyEgressAgents();
      srv.close();
    }
  });
});
