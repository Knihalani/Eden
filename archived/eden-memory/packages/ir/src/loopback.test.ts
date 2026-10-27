import { describe, expect, test } from "bun:test";
import { isLoopbackHost, isLoopbackName, isLoopbackOrigin, looksBrowserDriven } from "./loopback";

describe("loopback checks", () => {
  test("Host values name this machine only when they are a loopback name", () => {
    for (const host of ["127.0.0.1", "127.0.0.1:8788", "localhost:8788", "LOCALHOST", "[::1]:8788", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["evil.example:8788", "127.0.0.1.evil.example", "localhost.evil.example:8788", "10.0.0.2", ""]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  test("bind addresses", () => {
    expect(isLoopbackName("127.0.0.1")).toBe(true);
    expect(isLoopbackName("::1")).toBe(true);
    expect(isLoopbackName("localhost")).toBe(true);
    expect(isLoopbackName("0.0.0.0")).toBe(false);
    expect(isLoopbackName(undefined)).toBe(false);
  });

  test("origins are anchored", () => {
    expect(isLoopbackOrigin("http://localhost:3000")).toBe(true);
    expect(isLoopbackOrigin("https://127.0.0.1")).toBe(true);
    const foreign = ["https://evil.example", "http://localhost.evil.com", "http://evil.com/localhost", "null", ""];
    for (const origin of foreign) {
      expect(isLoopbackOrigin(origin)).toBe(false);
    }
  });

  test("a typed URL is not browser-driven; a fetch or a cross-site navigation is", () => {
    const req = (headers: Record<string, string>) => new Request("http://127.0.0.1/", { headers });
    expect(looksBrowserDriven(req({}))).toBe(false);
    expect(looksBrowserDriven(req({ "sec-fetch-site": "none" }))).toBe(false);
    expect(looksBrowserDriven(req({ "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(looksBrowserDriven(req({ origin: "http://localhost:3000" }))).toBe(true);
  });
});
