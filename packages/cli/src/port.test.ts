import { describe, expect, test } from "bun:test";
import { wrapListen } from "./wrap-cmd";

describe("port parsing", () => {
  test("a numeric --port is honoured", () => {
    expect(wrapListen(["--port", "9000"]).port).toBe(9000);
  });

  test("--port 0 means ephemeral, not the fallback", () => {
    const prev = process.env.PORT;
    delete process.env.PORT;
    try {
      expect(wrapListen(["--port", "0"]).port).toBe(0);
    } finally {
      if (prev !== undefined) process.env.PORT = prev;
    }
  });

  test("a non-numeric port is a usage error, not NaN into Bun.serve", () => {
    expect(() => wrapListen(["--port", "887o"])).toThrow(/invalid --port/);
  });

  test("out-of-range ports are rejected", () => {
    expect(() => wrapListen(["--port", "70000"])).toThrow(/invalid --port/);
    expect(() => wrapListen(["--port", "-1"])).toThrow(/invalid --port/);
  });

  test("PORT env is used when no flag is given", () => {
    const prev = process.env.PORT;
    process.env.PORT = "9100";
    try {
      expect(wrapListen([]).port).toBe(9100);
    } finally {
      if (prev === undefined) delete process.env.PORT;
      else process.env.PORT = prev;
    }
  });
});
