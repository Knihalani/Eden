import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Scope } from "@eden/protocol";
import { ReadOnlyViolation, type Source } from "@eden/sources";
import { z } from "zod";
import { buildPartner } from "./build";
import { sourcesFromEnv, staticSources } from "./connectors";
import { createHandler } from "./http";
import { fileDirectory, SourceConfigError, UserSources, type McpSpec, type SourceDirectory } from "./user-sources";

const alice: Scope = { tenantId: "acme", userId: "alice" };
const bob: Scope = { tenantId: "acme", userId: "bob" };
const query = (scope: Scope, text = "inbox") => ({ scope, text, entities: [], limit: 5 });
const signal = () => AbortSignal.timeout(2_000);

/**
 * One user's mail server, in memory: its only note names its owner, and it counts the connections opened to it and
 * the ones still open, so a test sees exactly which user's server a search reached and what a teardown closed.
 */
function mailServer(owner: string, readOnly = true) {
  const stats = { connects: 0, open: 0 };
  const transport = () => {
    const server = new McpServer({ name: `mail-${owner}`, version: "1" });
    server.registerTool(
      "search_mail",
      { inputSchema: { query: z.string() }, annotations: { readOnlyHint: readOnly } },
      async () => ({
        content: [
          { type: "text", text: JSON.stringify([{ id: `m-${owner}`, title: "inbox", text: `${owner}'s mail` }]) },
        ],
      }),
    );
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    stats.connects++;
    stats.open++;
    serverSide.onclose = () => stats.open--;
    void server.connect(serverSide);
    return client;
  };
  return { stats, transport };
}

const searchArgs = (q: { text: string }) => ({ query: q.text });
const mcpSpec = (transport: () => ReturnType<ReturnType<typeof mailServer>["transport"]>): McpSpec => ({
  kind: "mcp",
  id: "mail",
  description: "the user's mail",
  transport,
  searchTool: { name: "search_mail", args: searchArgs },
});

const settle = () => new Promise((r) => setTimeout(r, 20));
const opened: UserSources[] = [];
function userSources(directory: SourceDirectory, extra: Partial<ConstructorParameters<typeof UserSources>[0]> = {}) {
  const u = new UserSources({ directory, log: () => {}, ...extra });
  opened.push(u);
  return u;
}
afterEach(() => {
  for (const u of opened.splice(0)) u.close();
});

async function texts(sources: Source[], scope: Scope): Promise<string[]> {
  const out: string[] = [];
  for (const s of sources) out.push(...(await s.search(query(scope), signal())).map((i) => i.text));
  return out;
}

describe("UserSources: per-user sources and connections (D104)", () => {
  test("two users with the same source id reach only their own server, over their own connection", async () => {
    const servers = { alice: mailServer("alice"), bob: mailServer("bob") };
    const us = userSources((scope) => [mcpSpec(servers[scope.userId as "alice" | "bob"].transport)]);
    const a = await us.resolver(alice);
    const b = await us.resolver(bob);
    expect(a[0]).not.toBe(b[0]);
    expect(await texts(a, alice)).toEqual(["alice's mail"]);
    expect(await texts(b, bob)).toEqual(["bob's mail"]);
    // A second lookup reuses each user's connection; neither ever touched the other's server.
    await texts(await us.resolver(alice), alice);
    expect(servers.alice.stats.connects).toBe(1);
    expect(servers.bob.stats.connects).toBe(1);
    // Another tenant's user of the same name is another scope.
    const other = await us.resolver({ tenantId: "globex", userId: "alice" });
    expect(other[0]).not.toBe(a[0]);
  });

  test("each user's headers go to their own transport only (EDEN_USER_SOURCES_FILE, env headers)", async () => {
    const seen: { auth: string | null; path: string }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        seen.push({ auth: req.headers.get("authorization"), path: new URL(req.url).pathname });
        return new Response("no", { status: 401 });
      },
    });
    const prev = { a: process.env.EDEN_TEST_TOKEN_A, b: process.env.EDEN_TEST_TOKEN_B };
    process.env.EDEN_TEST_TOKEN_A = "Bearer token-of-alice";
    process.env.EDEN_TEST_TOKEN_B = "Bearer token-of-bob";
    try {
      const dir = mkdtempSync(join(tmpdir(), "eden-us-"));
      const file = join(dir, "users.json");
      const entry = (user: string, env: string) => [
        {
          kind: "mcp",
          id: "mail",
          description: "mail",
          url: `http://127.0.0.1:${server.port}/${user}`,
          headers: { Authorization: { env } },
          searchTool: { name: "search_mail" },
        },
      ];
      writeFileSync(
        file,
        JSON.stringify({ users: { "acme/alice": entry("alice", "EDEN_TEST_TOKEN_A"), "acme/bob": entry("bob", "B") } }),
      );
      // Every env header must be set at startup: "B" is not.
      expect(() => fileDirectory(file)).toThrow(/names B, which is not set/);
      writeFileSync(
        file,
        JSON.stringify({
          users: { "acme/alice": entry("alice", "EDEN_TEST_TOKEN_A"), "acme/bob": entry("bob", "EDEN_TEST_TOKEN_B") },
        }),
      );
      const us = userSources(fileDirectory(file));
      for (const scope of [alice, bob]) {
        const [mail] = await us.resolver(scope);
        await mail!.search(query(scope), signal()).catch(() => {}); // the server refuses: the header is what counts
      }
      expect(await us.resolver({ tenantId: "acme", userId: "carol" })).toEqual([]);
      expect(seen.length).toBeGreaterThan(0);
      for (const s of seen) expect(s.auth).toBe(s.path === "/alice" ? "Bearer token-of-alice" : "Bearer token-of-bob");
      expect(new Set(seen.map((s) => s.path))).toEqual(new Set(["/alice", "/bob"]));
    } finally {
      process.env.EDEN_TEST_TOKEN_A = prev.a;
      process.env.EDEN_TEST_TOKEN_B = prev.b;
      if (prev.a === undefined) delete process.env.EDEN_TEST_TOKEN_A;
      if (prev.b === undefined) delete process.env.EDEN_TEST_TOKEN_B;
      void server.stop(true);
    }
  });

  test("forget closes the user's connections, refuses the old handles, and leaves the other user alone", async () => {
    const servers = { alice: mailServer("alice"), bob: mailServer("bob") };
    const us = userSources((scope) => [mcpSpec(servers[scope.userId as "alice" | "bob"].transport)]);
    const [a] = await us.resolver(alice);
    const [b] = await us.resolver(bob);
    await texts([a!, b!], alice);
    expect(servers.alice.stats.open).toBe(1);
    us.forget(alice);
    await settle();
    expect(servers.alice.stats.open).toBe(0);
    expect(servers.bob.stats.open).toBe(1);
    expect(us.size).toBe(1);
    // A handle the engine still holds does not reconnect.
    await expect(a!.search(query(alice), signal())).rejects.toThrow(/source closed/);
    expect(servers.alice.stats.connects).toBe(1);
    expect(await texts([b!], bob)).toEqual(["bob's mail"]);
    // The next lookup asks the directory again and opens a fresh connection.
    expect(await texts(await us.resolver(alice), alice)).toEqual(["alice's mail"]);
    expect(servers.alice.stats.connects).toBe(2);
  });

  test("forget of one source closes only that source", async () => {
    const mail = mailServer("alice");
    const docs = { kind: "static" as const, id: "notes", description: "notes", docs: [] };
    const us = userSources(() => [mcpSpec(mail.transport), docs]);
    const before = await us.resolver(alice);
    await texts(
      before.filter((s) => s.id === "mail"),
      alice,
    );
    us.forget(alice, "mail");
    await settle();
    expect(mail.stats.open).toBe(0);
    const after = await us.resolver(alice);
    expect(after.find((s) => s.id === "notes")).toBe(before.find((s) => s.id === "notes"));
    expect(after.find((s) => s.id === "mail")).not.toBe(before.find((s) => s.id === "mail"));
  });

  test("a search in flight when the user is forgotten does not leave a connection open", async () => {
    const mail = mailServer("alice");
    const us = userSources(() => [mcpSpec(mail.transport)]);
    const [a] = await us.resolver(alice);
    const pending = a!.search(query(alice), signal()).catch(() => []);
    us.forget(alice); // while it connects
    await pending;
    await settle();
    expect(mail.stats.open).toBe(0);
  });

  test("idle users are closed by the sweep; past maxUsers the least recently used is closed", async () => {
    let now = 0;
    const servers = { alice: mailServer("alice"), bob: mailServer("bob") };
    const us = userSources((scope) => [mcpSpec(servers[scope.userId as "alice" | "bob"].transport)], {
      now: () => now,
      idleMs: 1_000,
      maxUsers: 1,
    });
    await texts(await us.resolver(alice), alice);
    now = 500;
    await texts(await us.resolver(bob), bob); // over the cap: alice goes
    await settle();
    expect(servers.alice.stats.open).toBe(0);
    expect(us.size).toBe(1);
    now = 2_000;
    us.sweep();
    await settle();
    expect(servers.bob.stats.open).toBe(0);
    expect(us.size).toBe(0);
  });

  test("a changed spec (a new credential) rebuilds the connection; an unchanged one is kept", async () => {
    let now = 0;
    const first = mailServer("alice");
    const second = mailServer("alice-rotated");
    let current = first.transport;
    const us = userSources(() => [mcpSpec(current)], { now: () => now, specTtlMs: 100 });
    const [a1] = await us.resolver(alice);
    await texts([a1!], alice);
    now = 200;
    await us.resolver(alice); // re-asks in the background
    await settle();
    expect((await us.resolver(alice))[0]).toBe(a1);
    current = second.transport;
    now = 400;
    await us.resolver(alice);
    await settle();
    const [a2] = await us.resolver(alice);
    expect(a2).not.toBe(a1);
    expect(await texts([a2!], alice)).toEqual(["alice-rotated's mail"]);
    await settle();
    expect(first.stats.open).toBe(0);
  });

  test("a directory error is that user's config error: no sources, connections closed, other users unaffected", async () => {
    let now = 0;
    let broken = false;
    const mail = mailServer("alice");
    const us = userSources(
      (scope) => {
        if (broken && scope.userId === "alice") throw new SourceConfigError("vault: alice's token was revoked");
        return [mcpSpec(mail.transport)];
      },
      { now: () => now, specTtlMs: 100 },
    );
    await texts(await us.resolver(alice), alice);
    broken = true;
    now = 200;
    await us.resolver(alice).catch(() => {});
    await settle();
    await expect(us.resolver(alice)).rejects.toBeInstanceOf(SourceConfigError);
    expect(mail.stats.open).toBe(0);
    expect((await us.resolver(bob)).map((s) => s.id)).toEqual(["mail"]);
    expect(await us.status(alice)).toEqual({ sources: [], error: "vault: alice's token was revoked" });
  });

  test("invalid specs from a directory are refused with the field named", async () => {
    const bad = [
      [{ kind: "mcp", id: "mail", description: "m", searchTool: { name: "s" } }, /exactly one of url or transport/],
      [{ kind: "mcp", id: "mail", description: "m", url: "ftp://x", searchTool: { name: "s" } }, /url must be http/],
      [{ kind: "mcp", id: "mail", description: "m", url: "https://x" }, /searchTool.name/],
      [{ kind: "ldap", id: "mail", description: "m" }, /kind must be/],
      [{ kind: "static", id: "a/b", description: "m", docs: [] }, /id must be/],
    ] as const;
    for (const [spec, why] of bad) {
      const us = userSources(() => [spec as never]);
      await expect(us.resolver(alice)).rejects.toThrow(why);
    }
    const twice = userSources(() => [
      { kind: "static", id: "a", description: "", docs: [] },
      { kind: "static", id: "a", description: "", docs: [] },
    ]);
    await expect(twice.resolver(alice)).rejects.toThrow(/listed twice/);
  });

  test("read-only (D7) is untouched: a search tool not marked read-only is refused through the handle", async () => {
    const mail = mailServer("alice", false);
    const us = userSources(() => [mcpSpec(mail.transport)]);
    const [a] = await us.resolver(alice);
    await expect(a!.search(query(alice), signal())).rejects.toBeInstanceOf(ReadOnlyViolation);
  });

  test("shared static sources are served beside each user's own; a user's own wins an id", async () => {
    const shared = staticSources(join(import.meta.dir, "../../../examples/personal-agent/sources.json"));
    const own = { kind: "static" as const, id: "gmail", description: "own", docs: [] };
    const us = userSources((scope) => (scope.userId === "alice" ? [own] : []), { shared });
    const a = await us.resolver(alice);
    expect(a.map((s) => `${s.id}:${s.description}`).sort()).toEqual(["calendar:The user's calendar", "gmail:own"]);
    expect((await us.resolver(bob)).map((s) => s.id).sort()).toEqual(["calendar", "gmail"]);
  });
});

describe("source files at startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "eden-sf-"));
  const write = (name: string, body: unknown) => {
    const p = join(dir, name);
    writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
    return p;
  };

  test("EDEN_SOURCES_FILE refuses an entry with no docs and points at EDEN_USER_SOURCES_FILE", () => {
    const p = write("shared.json", { sources: [{ id: "mail", description: "m", url: "https://x" }] });
    expect(() => staticSources(p)).toThrow(/sources\[0\] has no docs.*EDEN_USER_SOURCES_FILE/);
  });

  test("EDEN_USER_SOURCES_FILE: bad JSON, shape, keys and entries stop startup with a message", () => {
    expect(() => fileDirectory(write("a.json", "{nope"))).toThrow(/EDEN_USER_SOURCES_FILE/);
    expect(() => fileDirectory(write("b.json", { sources: [] }))).toThrow(/must be \{"users"/);
    expect(() => fileDirectory(write("c.json", { users: { alice: [] } }))).toThrow(/"<tenantId>\/<userId>"/);
    const bad = { users: { "acme/alice": [{ kind: "mcp", id: "m", description: "", url: "https://x" }] } };
    expect(() => fileDirectory(write("d.json", bad))).toThrow(/users\["acme\/alice"\]\[0\]\.searchTool\.name/);
  });

  test("sourcesFromEnv: static only without EDEN_USER_SOURCES_FILE, per user with it", async () => {
    const shared = write("s.json", { sources: [{ id: "faq", description: "faq", docs: [] }] });
    const plain = sourcesFromEnv({ EDEN_SOURCES_FILE: shared });
    expect(plain.userSources).toBeUndefined();
    expect((await plain.resolver(alice)).map((s) => s.id)).toEqual(["faq"]);
    const users = write("u.json", {
      users: { "acme/alice": [{ kind: "static", id: "notes", description: "n", docs: [] }] },
    });
    const per = sourcesFromEnv({ EDEN_SOURCES_FILE: shared, EDEN_USER_SOURCES_FILE: users });
    opened.push(per.userSources!);
    expect((await per.resolver(alice)).map((s) => s.id)).toEqual(["faq", "notes"]);
    expect((await per.resolver(bob)).map((s) => s.id)).toEqual(["faq"]);
  });
});

describe("HTTP with per-user sources", () => {
  const key = "k_acme_0123456789abcdef";
  const post = (handle: (r: Request) => Promise<Response>, path: string, body: unknown) =>
    handle(
      new Request(`http://x${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  test("/v1/sources lists the user's sources, 422 for a broken config, 404 without per-user sources", async () => {
    const notes = { kind: "static" as const, id: "notes", description: "n", docs: [] };
    const us = userSources((scope) => {
      if (scope.userId === "broken") throw new SourceConfigError("users[acme/broken][0].url is not a URL");
      return [notes];
    });
    const partner = buildPartner({ sources: us.resolver, model: null, queryPlanner: "off" });
    const handle = createHandler(partner, { keys: new Map([[key, "acme"]]), dev: false }, us);
    const ok = await post(handle, "/v1/sources", { userId: "alice" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ sources: [{ id: "notes", kind: "static" }] });
    const broken = await post(handle, "/v1/sources", { userId: "broken" });
    expect(broken.status).toBe(422);
    expect(((await broken.json()) as { error: string }).error).toMatch(/is not a URL/);
    expect((await post(handle, "/v1/sources", {})).status).toBe(400);
    // The engine treats a broken config as no sources: an ask is answered, never a 500.
    const ask = await post(handle, "/v1/ask", { userId: "broken", sessionId: "s1", question: "anything on Globex?" });
    expect(ask.status).toBe(200);
    const plain = createHandler(partner, { keys: new Map([[key, "acme"]]), dev: false });
    expect((await post(plain, "/v1/sources", { userId: "alice" })).status).toBe(404);
  });

  test("/v1/forget closes the user's connections", async () => {
    const mail = mailServer("alice");
    const us = userSources(() => [mcpSpec(mail.transport)]);
    const partner = buildPartner({ sources: us.resolver, model: null, queryPlanner: "off" });
    const handle = createHandler(partner, { keys: new Map([[key, "acme"]]), dev: false }, us);
    await texts(await us.resolver(alice), alice);
    expect(mail.stats.open).toBe(1);
    expect((await post(handle, "/v1/forget", { userId: "alice" })).status).toBe(200);
    await settle();
    expect(mail.stats.open).toBe(0);
    expect(us.size).toBe(0);
  });
});
