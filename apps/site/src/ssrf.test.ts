import { describe, expect, test } from "bun:test";
import { checkEgressUrl, isBlockedHost, parseIpv4, safeFetch } from "./ssrf";

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
