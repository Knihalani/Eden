import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import {
  checkEgressUrl,
  destroyEgressAgents,
  EGRESS_TIMEOUT_MS,
  isBlockedHost,
  parseIpv4,
  parseIpv6,
  pinnedFetch,
  safeFetch,
} from "./ssrf";

describe("isBlockedHost", () => {
  test("blocks loopback and private ranges the old guard let through", () => {
    // The previous guard only knew about `.internal` and `169.254.*`, so every
    // one of these reached the network from inside the server.
    for (const h of [
      "127.0.0.1",
      "127.1",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1",
      "localhost",
      "::1",
      "[::1]",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect({ host: h, blocked: isBlockedHost(h) }).toEqual({ host: h, blocked: true });
    }
  });

  test("blocks cloud metadata and internal suffixes", () => {
    for (const h of ["169.254.169.254", "metadata.google.internal", "foo.internal", "db.local", "x.home.arpa"]) {
      expect({ host: h, blocked: isBlockedHost(h) }).toEqual({ host: h, blocked: true });
    }
  });

  test("blocks alternate encodings of a loopback address", () => {
    // `new URL("http://2130706433/")` connects to 127.0.0.1, so a guard that
    // only string-matches "127." is trivially bypassed.
    expect(parseIpv4("2130706433")).toBe(0x7f000001);
    expect(parseIpv4("0x7f000001")).toBe(0x7f000001);
    expect(parseIpv4("0177.0.0.1")).toBe(0x7f000001);
    for (const h of ["2130706433", "0x7f000001", "0177.0.0.1", "127.0.1"]) {
      expect({ host: h, blocked: isBlockedHost(h) }).toEqual({ host: h, blocked: true });
    }
  });

  test("allows ordinary public hosts", () => {
    for (const h of ["api.github.com", "example.com", "8.8.8.8", "1.1.1.1"]) {
      expect({ host: h, blocked: isBlockedHost(h) }).toEqual({ host: h, blocked: false });
    }
  });

  test("is not fooled by a trailing dot or case", () => {
    expect(isBlockedHost("LOCALHOST")).toBe(true);
    expect(isBlockedHost("localhost.")).toBe(true);
    expect(isBlockedHost("Metadata.Google.Internal")).toBe(true);
  });
});

describe("checkEgressUrl", () => {
  test("rejects non-http schemes", async () => {
    const r = await checkEgressUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("scheme");
  });

  test("rejects a private literal", async () => {
    const r = await checkEgressUrl("http://169.254.169.254/latest/meta-data/");
    expect(r.ok).toBe(false);
  });

  test("accepts a public literal without needing DNS", async () => {
    const r = await checkEgressUrl("https://8.8.8.8/");
    expect(r.ok).toBe(true);
  });
});

describe("safeFetch", () => {
  const ok = () => new Response("fine", { status: 200 });
  const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });

  test("refuses a redirect into the private network", async () => {
    // The core bypass: the first URL passes every check, and the *response*
    // moves the request somewhere it should never go. Default fetch() follows
    // this silently.
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls++;
      return String(url).includes("8.8.8.8") ? redirectTo("http://169.254.169.254/latest/") : ok();
    }) as unknown as typeof fetch;

    await expect(safeFetch("https://8.8.8.8/start", {}, { fetchImpl })).rejects.toThrow(/blocked host/);
    expect(calls).toBe(1); // the internal hop was never issued
  });

  test("follows a redirect between public hosts", async () => {
    const fetchImpl = (async (url: string) =>
      String(url).includes("/start") ? redirectTo("https://1.1.1.1/done") : ok()) as unknown as typeof fetch;
    const res = await safeFetch("https://8.8.8.8/start", {}, { fetchImpl });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("fine");
  });

  test("gives up rather than looping forever", async () => {
    const fetchImpl = (async () => redirectTo("https://8.8.8.8/next")) as unknown as typeof fetch;
    await expect(safeFetch("https://8.8.8.8/start", {}, { fetchImpl, maxRedirects: 2 })).rejects.toThrow(
      /too many redirects/,
    );
  });

  test("passes the response straight through when there is no redirect", async () => {
    const fetchImpl = (async () => ok()) as unknown as typeof fetch;
    const res = await safeFetch("https://8.8.8.8/x", { method: "GET" }, { fetchImpl });
    expect(res.status).toBe(200);
  });
});

describe("IPv6 is parsed, not pattern-matched", () => {
  test("blocks IPv4-mapped loopback and metadata written in hex", () => {
    // The first version of this guard matched a dotted-quad tail with a regex.
    // `::ffff:7f00:1` is `::ffff:127.0.0.1` spelled in hex and went straight
    // through to loopback; `::ffff:a9fe:a9fe` reached the cloud metadata
    // endpoint the guard exists to protect.
    for (const h of [
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "::ffff:0a00:0001",
      "0:0:0:0:0:ffff:7f00:1",
      "::7f00:1",
      "::ffff:c0a8:1",
      "64:ff9b::7f00:1",
    ]) {
      expect({ host: h, blocked: isBlockedHost(h) }).toEqual({ host: h, blocked: true });
    }
  });

  test("blocks the v6 ranges that are never publicly routable", () => {
    for (const h of ["::", "::1", "fd00::1", "fc00::abcd", "fe80::1", "ff02::1"]) {
      expect({ host: h, blocked: isBlockedHost(h) }).toEqual({ host: h, blocked: true });
    }
  });

  test("still allows public v6", () => {
    for (const h of ["2001:4860:4860::8888", "2606:4700:4700::1111", "::ffff:808:808", "::ffff:8.8.8.8"]) {
      expect({ host: h, blocked: isBlockedHost(h) }).toEqual({ host: h, blocked: false });
    }
  });

  test("expands :: and a dotted tail to eight groups", () => {
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIpv6("2001:db8::1")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  test("fails closed on a spelling it cannot parse", () => {
    for (const h of ["::::1", "12345::1", "2001:db8:::1", "gggg::1"]) {
      expect({ host: h, blocked: isBlockedHost(h) }).toEqual({ host: h, blocked: true });
    }
  });
});

describe("safeFetch does not leak credentials across a redirect", () => {
  test("drops Authorization when a redirect changes origin", async () => {
    // playback attaches `Authorization: Bearer $GITHUB_TOKEN` for
    // api.github.com. WHATWG fetch strips credentials on a cross-origin
    // redirect; following hops by hand means doing that ourselves, and the
    // first version of this loop replayed the header verbatim to whatever host
    // a 302 named.
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init.headers).get("authorization") });
      return String(url).includes("8.8.8.8")
        ? new Response(null, { status: 302, headers: { location: "https://1.1.1.1/steal" } })
        : new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await safeFetch(
      "https://8.8.8.8/start",
      { headers: { authorization: "Bearer SECRET", cookie: "s=1", accept: "application/json" } },
      { fetchImpl },
    );
    expect(seen[0]!.auth).toBe("Bearer SECRET");
    expect(seen[1]!.auth).toBeNull();
  });

  test("keeps Authorization on a same-origin redirect", async () => {
    const seen: Array<string | null> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get("authorization"));
      return String(url).endsWith("/start")
        ? new Response(null, { status: 302, headers: { location: "https://8.8.8.8/next" } })
        : new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await safeFetch("https://8.8.8.8/start", { headers: { authorization: "Bearer SECRET" } }, { fetchImpl });
    expect(seen).toEqual(["Bearer SECRET", "Bearer SECRET"]);
  });
});

describe("egress connects only where the check cleared", () => {
  /**
   * checkEgressUrl resolved the hostname and cleared the addresses; fetch then
   * resolved it a second time, independently. Nothing tied the two together,
   * so re-pointing DNS in between (rebinding) defeated the guard entirely —
   * the file's own header used to say so.
   *
   * Neither runtime lets `fetch` control where a connection goes: Bun has no
   * dispatcher or lookup option, and Bun's built-in undici shim *accepts* an
   * Agent with `connect.lookup` and silently ignores it, which is worse than
   * refusing. node:http(s) `.request({ lookup })` is honoured by both.
   */
  test("the connection goes to the pinned address while Host stays the hostname", async () => {
    const seen: string[] = [];
    const srv = createServer((req, res) => {
      seen.push(String(req.headers.host));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const f = pinnedFetch([{ address: "127.0.0.1", family: 4 }]);
      // Three in a row on purpose. Bun takes ownership of the array handed to
      // the lookup callback, so reusing one made the first request succeed and
      // every one after it fail with ENOTFOUND — a bug a single-request test
      // cannot see.
      for (let i = 0; i < 3; i++) {
        const res = await f(`http://example.com:${port}/x`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      }
      // Host and TLS servername still come from the URL, so certificate
      // validation and virtual hosting are unaffected — only address
      // selection is overridden.
      expect(seen).toHaveLength(3);
      expect(seen.every((h) => h.startsWith("example.com"))).toBe(true);
    } finally {
      destroyEgressAgents();
      srv.close();
    }
  });

  test("a pinned address that does not serve is refused, not silently re-resolved", async () => {
    // Hostname-keyed keep-alive skips lookup on reuse and would silently
    // un-pin this. Pooling is keyed by the pinned address, so a pin at
    // 127.0.0.1 still cannot land on GitHub's real IP.
    const f = pinnedFetch([{ address: "127.0.0.1", family: 4 }]);
    await expect(f("https://api.github.com/")).rejects.toThrow();
  });

  test("a response larger than the ceiling is refused", async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(200);
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      for (let i = 0; i < 16; i++) res.write(chunk);
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const f = pinnedFetch([{ address: "127.0.0.1", family: 4 }]);
      await expect(f(`http://example.com:${port}/big`)).rejects.toThrow(/exceeded/);
    } finally {
      destroyEgressAgents();
      srv.close();
    }
  });

  test("a target that accepts and then says nothing is timed out", async () => {
    const srv = createServer(() => {
      /* accept, never respond */
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const f = pinnedFetch([{ address: "127.0.0.1", family: 4 }]);
      const started = Date.now();
      await expect(
        Promise.race([
          f(`http://example.com:${port}/hang`),
          new Promise((_r, rej) => setTimeout(() => rej(new Error("test gave up first")), EGRESS_TIMEOUT_MS + 5_000)),
        ]),
      ).rejects.toThrow(/timeout/);
      expect(Date.now() - started).toBeLessThan(EGRESS_TIMEOUT_MS + 5_000);
    } finally {
      destroyEgressAgents();
      srv.close();
    }
  }, 30_000);
});
