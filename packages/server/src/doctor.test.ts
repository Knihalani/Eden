import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EdenClient } from "@eden/client";
import { StaticSource } from "@eden/sources";
import { buildPartner } from "./build";
import { configEvidence, diagnose, fetchCounts, render, traceEvidence, type Finding } from "./doctor";
import { createHandler } from "./http";
import { IntegrationStats, isActingTool } from "./integration-stats";

// D852: `eden doctor` names each integration obligation that is not met, from the server's content-free counters.

const KEYS = new Map([
  ["k_good_0123456789abcdef", "good"],
  ["k_bad_01234567890abcdef", "bad"],
]);
const source = new StaticSource("calendar", "The user's calendar", [
  { ref: "e1", title: "Lunch with Priya Raman", text: "Thursday 12:30 at Dishoom" },
]);
const partner = buildPartner({ sources: async () => [source], model: null });
const server = Bun.serve({ port: 0, fetch: createHandler(partner, { keys: KEYS, dev: false }) });
afterAll(() => {
  server.stop(true);
  partner.stopSync();
});
const url = server.url.href;
const statusOf = (fs: Finding[], id: string) => fs.find((f) => f.id === id)?.status;

describe("eden doctor (D852)", () => {
  test("a careless integration: no wait, no ask, unchecked acting calls, bare signals, no session_start", async () => {
    for (let i = 0; i < 6; i++) {
      const eden = new EdenClient({
        apiKey: "k_bad_01234567890abcdef",
        userId: `u${i}`,
        sessionId: "s",
        baseUrl: url,
        defaultWaitMs: 0,
        onError: null,
      });
      await eden.observe({ kind: "user_message", text: "Move lunch with Priya Raman to Friday" });
      await eden.observe({ kind: "tool_call", tool: "send_email", input: { to: "priya@example.com" } });
      await eden.sourceChanged("calendar");
    }
    const got = await fetchCounts(url, "k_bad_01234567890abcdef");
    if (!("counts" in got)) throw new Error(got.error);
    const fs = diagnose({ counts: got.counts });
    expect(statusOf(fs, "report-user-messages")).toBe("met");
    expect(statusOf(fs, "wait-on-user-message")).toBe("unmet");
    expect(statusOf(fs, "ask-context")).toBe("unknown"); // under 20 user messages: too few to call it
    expect(statusOf(fs, "check-acting-tools")).toBe("unmet");
    expect(statusOf(fs, "session-start")).toBe("unmet");
    expect(statusOf(fs, "change-notices")).toBe("unmet");
    expect(statusOf(fs, "keep-packets")).toBe("unknown");
    const text = render(fs);
    expect(text).toContain("FIX  Check each acting tool call");
    expect(text).toContain("12 in 576 tasks"); // the measured penalty is printed with the fix
    expect(text).toContain("guardTools");
  });

  test("a careful integration meets each obligation the counters can see; tenants never mix", async () => {
    for (let i = 0; i < 6; i++) {
      const eden = new EdenClient({
        apiKey: "k_good_0123456789abcdef",
        userId: `u${i}`,
        sessionId: "s",
        baseUrl: url,
        onError: null,
      });
      await eden.observe({ kind: "session_start" });
      const { injection } = await eden.observe(
        { kind: "user_message", text: "Move lunch with Priya Raman" },
        { waitMs: 3_000 },
      );
      await eden.collect(injection);
      await eden.ask("When is lunch with Priya?");
      await eden.check("send_email", { to: "priya@example.com" });
      await eden.observe({ kind: "tool_call", tool: "send_email", input: { to: "priya@example.com" } });
      await eden.observe({ kind: "agent_message", text: "Done." });
      await eden.sourceChanged("calendar", { refs: ["e1"] });
    }
    const got = await fetchCounts(url, "k_good_0123456789abcdef");
    if (!("counts" in got)) throw new Error(got.error);
    const c = got.counts;
    // Only this tenant's calls: the careless tenant's six users are not here.
    expect(c.sessions.seen).toBe(6);
    expect(c.userWait).toEqual({ none: 0, short: 0, full: 6 });
    const fs = diagnose({ counts: c });
    for (const id of ["report-user-messages", "wait-on-user-message", "report-agent-side", "check-acting-tools"]) {
      expect([id, statusOf(fs, id)]).toEqual([id, "met"]);
    }
    expect(statusOf(fs, "session-start")).toBe("met");
    expect(statusOf(fs, "ask-context")).toBe("met");
    expect(statusOf(fs, "change-notices")).toBe("met");
    expect(statusOf(fs, "requests-accepted")).toBe("met");
  });

  test("refused requests are counted per tenant; a wrong key is reported, not thrown", async () => {
    const eden = new EdenClient({
      apiKey: "k_good_0123456789abcdef",
      userId: "bad id!",
      sessionId: "s",
      baseUrl: url,
      onError: null,
    });
    await eden.observe({ kind: "user_message", text: "hi" });
    const got = await fetchCounts(url, "k_good_0123456789abcdef");
    if (!("counts" in got)) throw new Error(got.error);
    expect(statusOf(diagnose({ counts: got.counts }), "requests-accepted")).toBe("unmet");
    expect(await fetchCounts(url, "k_wrong_000000000000000")).toEqual({
      error: "the server answered 401 (check EDEN_API_KEY)",
    });
    expect("error" in (await fetchCounts("http://127.0.0.1:9", undefined))).toBe(true);
  });

  test("a trace log alone gives sessions, event kinds and asks", () => {
    const t = (sessionId: string, event: string, decision = "skipped") =>
      JSON.stringify({
        sessionId,
        turn: 0,
        event,
        decision,
        reason: "x",
        latencyMs: 1,
        sourceCalls: 0,
        modelCalls: 0,
        costUsd: 0,
        itemIds: [],
      });
    const lines = [
      "eden listening",
      ...["a", "b", "c", "d", "e"].flatMap((s) => [
        t(s, "session_start"),
        t(s, "user_message", "silent"),
        t(s, "tool_call"),
      ]),
      t("a", "ask", "answer"),
      JSON.stringify({ usage: { how: "inferred", used: true } }),
    ];
    const ev = traceEvidence(lines);
    expect(ev).toMatchObject({ sessions: 5, sessionsStarted: 5, sessionsWithUser: 5, sessionsWithAgent: 5, asks: 1 });
    expect(ev.usage).toEqual({ inferred: 1 });
    const fs = diagnose({ traces: ev });
    expect(statusOf(fs, "session-start")).toBe("met");
    expect(statusOf(fs, "report-agent-side")).toBe("met");
    // Not visible in traces: no finding claims to know them.
    expect(fs.find((f) => f.id === "wait-on-user-message")).toBeUndefined();
  });

  test("the configuration: names and counts only, never a value", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-doctor-"));
    const file = join(dir, "users.json");
    writeFileSync(
      file,
      JSON.stringify({
        users: {
          "acme/alice": [
            {
              kind: "mcp",
              id: "mail",
              description: "Mail",
              url: "https://mcp.example/x",
              searchTool: { name: "search", queryArg: "q" },
              notifies: true,
              headers: { authorization: "Bearer sekrit-token-value" },
            },
          ],
        },
      }),
    );
    const cfg = configEvidence({ EDEN_API_KEYS: "acme:sekrit-key-value-123", EDEN_USER_SOURCES_FILE: file });
    expect(cfg.sources).toMatchObject({ users: 1, mcp: 1, notifying: 1 });
    const out = render(diagnose({ config: cfg })) + JSON.stringify(diagnose({ config: cfg }));
    expect(out).not.toContain("sekrit");
    expect(statusOf(diagnose({ config: cfg }), "config-auth")).toBe("met");
    expect(statusOf(diagnose({ config: configEvidence({ EDEN_DEV: "1" }) }), "config-sources")).toBe("unmet");
  });
});

describe("IntegrationStats", () => {
  test("acting tools are named by verb, camelCase too", () => {
    expect(["send_email", "sendEmail", "calendar.create_event", "book"].every(isActingTool)).toBe(true);
    expect(["search_mail", "read_doc", "list_events"].some(isActingTool)).toBe(false);
  });

  test("two tenants with the same user and session ids are counted apart (D9)", () => {
    const s = new IntegrationStats();
    s.event("a", { kind: "user_message", userId: "u", sessionId: "s" }, 3_000, true, false);
    s.pending("a", "u", "s", false);
    s.event("b", { kind: "session_start", userId: "u", sessionId: "s" }, 0, false, false);
    expect(s.of("a").sessions).toMatchObject({ seen: 1, withUser: 1, started: 0, gotPending: 1, tookPending: 1 });
    expect(s.of("b").sessions).toMatchObject({ seen: 1, withUser: 0, started: 1, startedFirst: 1 });
    expect(s.of("c").sessions.seen).toBe(0);
  });
});
