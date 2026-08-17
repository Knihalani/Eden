import { describe, expect, test } from "bun:test";
import { checkEgressUrl, isBlockedHost, parseIpv4, parseIpv6, safeFetch } from "./ssrf";

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
  const redirectTo = (location: string) =>
    new Response(null, { status: 302, headers: { location } });

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
