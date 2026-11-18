import { expect, test } from "bun:test";
import { localBoundary, localConfig } from "./local";

const token = "a".repeat(43);
test("local configuration scrubs capabilities and consumes the token", () => {
  const env = { EDEN_LOCAL: "1", EDEN_LOCAL_TOKEN: token, EDEN_HOME: "/unused", OPENROUTER_API_KEY: "fake" };
  const log = console.log;
  const info = console.info;
  try {
    const config = localConfig(env)!;
    expect(console.log).toBe(log);
    expect(console.info).toBe(info);
    expect(config.keys.get(token)).toBe("local");
    expect(config).toMatchObject({ dev: false, port: 0, host: "127.0.0.1", persist: null, processes: 1 });
    expect(Object.keys(env)).toEqual(["EDEN_LOCAL"]);
    expect(localConfig({})).toBeNull();
    for (const value of ["", "x", "a".repeat(257), "a".repeat(31), "!".repeat(43)]) {
      expect(() => localConfig({ EDEN_LOCAL: "1", EDEN_LOCAL_TOKEN: value })).toThrow("EDEN_LOCAL_TOKEN");
    }
    expect(() => localConfig({ EDEN_LOCAL: "yes" })).toThrow("EDEN_LOCAL must");
  } finally {
    console.log = log;
    console.info = info;
  }
});

test("all local console diagnostics leave stdout empty", async () => {
  const file = new URL("./local.ts", import.meta.url).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { redirectLocalConsole } from ${JSON.stringify(file)};
    redirectLocalConsole();
    for (const method of ["log", "info", "debug", "trace", "dir", "dirxml", "table"]) console[method](method);
    console.count("counter"); console.time("timer"); console.timeLog("timer"); console.timeEnd("timer");
    console.group("group"); console.log("nested"); console.groupEnd();
    console.assert(false, "assertion"); console.write("raw-write");
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(await stdout).toBe("");
  const diagnostics = await stderr;
  for (const marker of ["log", "info", "debug", "[eval]", "dir", "table", "counter", "timer", "nested", "raw-write"]) {
    expect(diagnostics).toContain(marker);
  }
});

test("local boundary protects all routes before ops and authenticates metrics", async () => {
  const handle = localBoundary(
    () => new Response("ok"),
    () => 1234,
    token,
  );
  const forbidden = await handle(new Request("http://localhost/healthz"));
  expect(forbidden.headers.get("content-type")).toContain("application/json");
  expect(await forbidden.json()).toEqual({ error: "local mode serves only this machine's Host, with no Origin" });
  const unauthorized = await handle(new Request("http://localhost/metrics", { headers: { host: "localhost:1234" } }));
  expect(unauthorized.status).toBe(401);
  expect(await unauthorized.json()).toEqual({ error: "missing or unknown API key" });
  for (const path of ["/healthz", "/readyz", "/metrics", "/internal/cluster", "/v1/ask"]) {
    for (const host of ["evil:1234", "127.0.0.1", "localhost:1235", "LOCALHOST:1234"]) {
      expect((await handle(new Request(`http://localhost${path}`, { headers: { host } }))).status).toBe(403);
    }
    expect(
      (
        await handle(
          new Request(`http://localhost${path}`, {
            headers: { host: "localhost:1234", origin: "null", authorization: `Bearer ${token}` },
          }),
        )
      ).status,
    ).toBe(403);
  }
  for (const auth of ["", "wrong", token]) {
    expect(
      (
        await handle(
          new Request("http://localhost/metrics", {
            headers: { host: "127.0.0.1:1234", authorization: `Bearer ${auth}` },
          }),
        )
      ).status,
    ).toBe(auth === token ? 200 : 401);
  }
  expect((await handle(new Request("http://localhost/healthz", { headers: { host: "localhost:1234" } }))).status).toBe(
    200,
  );
});
