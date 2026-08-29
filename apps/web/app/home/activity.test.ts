import {
  activityFromInbox,
  EMPTY_ACTIVITY,
  failureModeLabel,
  formatDcPct,
  inboxItems,
  lastReceiptKind,
  receiptSeries,
  requestStatus,
  statusTone,
  workflowServing,
  workflowStatus,
  type InboxSlice,
} from "./activity";
import { failLabel } from "../canvas/fail";
import { expect, test } from "bun:test";

test("empty inbox stays honest zeros", () => {
  const empty = activityFromInbox(null);
  expect(empty.runs).toBe(0);
  expect(empty.compiled).toBe(0);
  expect(empty.waiting).toBe(0);
  expect(empty.fails).toBe(0);
  expect(empty.llmTimes).toBe(0);
  expect(empty.tokensSaved).toBe(0);
  expect(empty.dcPct).toBeNull();
  expect(empty.failed).toBe(false);
  expect(empty.workflows).toEqual([]);
  expect(empty.requests).toEqual([]);
  expect(empty.fleet).toEqual({ agents: [], fleetDcPct: null, sharedLine: null });
  expect(formatDcPct(empty.fleet?.fleetDcPct ?? null)).toBe("—");
  expect(empty.series).toHaveLength(7);
  expect(empty.dcSeries).toHaveLength(7);
  expect(empty.dcSeries.every((point) => point.measured === false && point.dcPct === 0)).toBe(true);
  expect(formatDcPct(empty.dcPct)).toBe("—");
  expect(activityFromInbox({}).runs).toBe(0);
  expect(activityFromInbox({}).dcPct).toBeNull();
});

test("maps wrap rows, drops seed ids, and does not invent tokens", () => {
  const inbox: InboxSlice = {
    candidates: [
      { id: "cand_pending", program: { name: "seed" }, verdict: "pending", created_at: 9 },
      { id: "req_1", program: { name: "brief" }, verdict: "PASS", created_at: 20 },
    ],
    live: [
      { id: "live_notify", name: "seed", state: "live", stats: { n: 96, fail: 2 }, updated_at: 8 },
      { id: "wf_1", name: "notify", state: "paused", stats: { n: 4, fail: 1 }, updated_at: 30 },
    ],
    savings: { runs: 100, live: 1, llmReductionMean: 5 },
  };
  expect(activityFromInbox(inbox)).toMatchObject({
    runs: 0,
    compiled: 0,
    waiting: 1,
    fails: 0,
    llmTimes: 0,
    tokensSaved: 0,
    dcPct: null,
    failed: false,
    workflows: [{ id: "wf_1", name: "notify", state: "paused", at: 30, runs: 4, fails: 1, llmTimes: 0 }],
    requests: [{ id: "req_1", name: "brief", verdict: "PASS", refused: false, at: 20 }],
  });
});

test("runs count receipts on remaining live tools, not leftover seed savings", () => {
  const inbox: InboxSlice = {
    live: [
      { id: "live_notify", name: "seed", state: "live", stats: { n: 90 }, updated_at: 1 },
      {
        id: "wf_real",
        name: "notify",
        state: "live",
        stats: { n: 3, fail: 1 },
        program: { manifest: { llmReduction: 5 } },
        updated_at: 40,
      },
    ],
    savings: { runs: 93, live: 2, llmReductionMean: 9 },
  };
  const activity = activityFromInbox(inbox);
  expect(activity.runs).toBe(3);
  expect(activity.compiled).toBe(1);
  expect(activity.fails).toBe(1);
  expect(activity.llmTimes).toBe(0);
  expect(activity.tokensSaved).toBe(0);
  expect(activity.dcPct).toBeNull();
  expect(activity.dcSeries.every((point) => point.measured === false)).toBe(true);
});

test("drops live rows without a real state so they cannot unlock runs", () => {
  const inbox: InboxSlice = {
    live: [{ id: "wf_ghost", name: "ghost", stats: { n: 12 } }],
    savings: { runs: 12, live: 1 },
  };
  const activity = activityFromInbox(inbox);
  expect(activity.runs).toBe(0);
  expect(activity.compiled).toBe(0);
  expect(activity.workflows).toEqual([]);
});

test("named compile refusals show class and counts on Needs attention", () => {
  const items = inboxItems({
    ...EMPTY_ACTIVITY,
    requests: [
      {
        id: "req_rs",
        name: "grepCode_to_writeNotes",
        verdict: "FAIL",
        refused: true,
        at: 1,
        refusalCode: "read_set_mismatch",
        readSet: 12,
        repeats: 6,
        refusalReason: "readFile repeats 6x without a bindable foreach",
      },
    ],
  });
  expect(items[0]?.status).toBe("Read-set · 6 of 12");
});

test("Needs attention ranks named near-misses above a pending row", () => {
  const items = inboxItems({
    ...EMPTY_ACTIVITY,
    requests: [
      { id: "pend", name: "wait", verdict: "pending", refused: false, at: 90 },
      {
        id: "rs",
        name: "grep",
        verdict: "FAIL",
        refused: true,
        at: 10,
        refusalCode: "read_set_mismatch",
        readSet: 12,
        repeats: 6,
      },
      { id: "loop", name: "each", verdict: "FAIL", refused: true, at: 20, refusalCode: "unbound_foreach" },
    ],
  });
  expect(items.map((item) => [item.id, item.status])).toEqual([
    ["request:loop", "Unbound loop"],
    ["request:rs", "Read-set · 6 of 12"],
    ["request:pend", "Pending"],
  ]);
});

test("empty Needs attention stays empty — ranking does not invent rows", () => {
  expect(inboxItems(EMPTY_ACTIVITY)).toEqual([]);
});

test("higher waste ranks above lower waste even if older", () => {
  const items = inboxItems({
    ...EMPTY_ACTIVITY,
    requests: [
      {
        id: "low",
        name: "cheap",
        verdict: "FAIL",
        refused: true,
        at: 90,
        wastedTokens: 40,
        refusalCode: "unbound_foreach",
      },
      {
        id: "high",
        name: "expensive",
        verdict: "FAIL",
        refused: true,
        at: 1,
        wastedTokens: 800,
        refusalCode: "too_short",
      },
    ],
  });
  expect(items.map((item) => [item.id, item.status])).toEqual([
    ["request:high", "Too short"],
    ["request:low", "Unbound loop"],
  ]);
});

test("waiting PASS with waste 4000 ranks above a refusal with 45", () => {
  const activity = activityFromInbox({
    candidates: [
      {
        id: "cheap",
        program: { name: "cheap" },
        verdict: "FAIL",
        created_at: 90,
        refusal: { code: "unbound_foreach", wastedTokens: 45 },
      },
      {
        id: "desk",
        program: { name: "getAccount_to_emailCustomer", wastedTokens: 4000 },
        verdict: "PASS",
        created_at: 1,
      },
    ],
  });
  expect(activity.requests.find((item) => item.id === "desk")?.wastedTokens).toBe(4000);
  expect(activity.requests.find((item) => item.id === "cheap")?.wastedTokens).toBe(45);
  expect(inboxItems(activity).map((item) => [item.id, item.status])).toEqual([
    ["request:desk", "Ready"],
    ["request:cheap", "Unbound loop"],
  ]);
});

test("unique-work Needs attention stays empty — no invented waste rows", () => {
  expect(inboxItems(EMPTY_ACTIVITY)).toEqual([]);
  expect(
    inboxItems({
      ...EMPTY_ACTIVITY,
      requests: [
        {
          id: "uw",
          name: "alpha_to_uniq0",
          verdict: "FAIL",
          refused: true,
          at: 50,
          wastedTokens: 9000,
          failureMode: "Unique work",
        },
      ],
    }),
  ).toEqual([]);
});

test("a drift replacement request uses the same waiting words as the canvas", () => {
  const items = inboxItems({
    ...EMPTY_ACTIVITY,
    requests: [
      { id: "pend", name: "wait", verdict: "pending", refused: false, at: 10 },
      {
        id: "rc_live",
        name: "pr_status",
        verdict: "PASS",
        refused: false,
        at: 20,
        failureMode: "refresh",
      },
    ],
  });
  expect(items[0]?.status).toBe("Replacement waiting");
  expect(items.map((item) => item.id)).toEqual(["request:rc_live", "request:pend"]);
});

test("activityFromInbox maps a candidate description onto Replacement waiting", () => {
  const activity = activityFromInbox({
    candidates: [
      {
        id: "rc:tool_1",
        sequence: ["get_pr", "merge"],
        verdict: "PASS",
        created_at: 1,
        program: {
          name: "pr_status",
          description: "The outside world renamed a field. A replacement is waiting. The live tool is unchanged until you Approve.",
        },
      },
    ],
  });
  expect(activity.requests[0]?.failureMode).toBe("refresh");
  expect(inboxItems(activity)[0]?.status).toBe("Replacement waiting");
});

test("remainder copy is not invented on EMPTY_ACTIVITY", () => {
  expect(inboxItems(EMPTY_ACTIVITY)).toEqual([]);
  expect(EMPTY_ACTIVITY.workflows).toEqual([]);
  expect(EMPTY_ACTIVITY.requests).toEqual([]);
  expect(EMPTY_ACTIVITY.runs).toBe(0);
  expect(EMPTY_ACTIVITY.fails).toBe(0);
  expect(EMPTY_ACTIVITY.dcPct).toBeNull();
  expect(JSON.stringify(EMPTY_ACTIVITY)).not.toMatch(/Skipped|Degraded|already served|host kept/i);
  const empty = activityFromInbox(null, [
    { tool_id: "wf_ghost", ok: 1, tokenClass: "steered-skip", skipped: ["Grep"], created_at: 1 },
  ]);
  expect(empty.workflows).toEqual([]);
  expect(inboxItems(empty)).toEqual([]);
  expect(JSON.stringify(empty)).not.toMatch(/Skipped|Degraded|already served/i);
});

test("labels wrap verdicts and refusals, newest first", () => {
  const inbox: InboxSlice = {
    candidates: [
      { id: "old", sequence: ["lookup", "notify"], verdict: "INCONCLUSIVE", created_at: 10 },
      { id: "new", program: null, sequence: ["search"], verdict: "FAIL", refusal: { reason: "weak" }, created_at: 50 },
    ],
  };
  const activity = activityFromInbox(inbox);
  expect(activity.waiting).toBe(1);
  expect(activity.fails).toBe(1);
  expect(activity.requests.map((item) => [item.id, item.name, requestStatus(item.verdict, item.refused)])).toEqual([
    ["new", "search", "Refused"],
    ["old", "lookup_notify", "Inconclusive"],
  ]);
});

test("inboxItems puts requests first and labels status", () => {
  const items = inboxItems({
    ...EMPTY_ACTIVITY,
    requests: [{ id: "req_1", name: "brief", verdict: "PASS", refused: false, at: 1 }],
    workflows: [{ id: "wf_1", name: "notify", state: "paused", at: 2, runs: 0, fails: 0, llmTimes: 0 }],
  });
  expect(items.map((item) => [item.kind, item.name, item.status, item.href])).toEqual([
    ["request", "brief", "Ready", "/request/req_1"],
    ["workflow", "notify", "Paused", "/live/wf_1"],
  ]);
});

test("requests keyed by failure mode start from the warning", () => {
  const items = inboxItems({
    ...EMPTY_ACTIVITY,
    requests: [
      {
        id: "req_loop",
        name: "search_to_write",
        verdict: "pending",
        refused: false,
        at: 1,
        failureMode: "loop",
        firstWarningAt: 3,
      },
    ],
  });
  expect(items[0]?.status).toBe("Loop · from call 3");
});

test("activityFromInbox maps wrap origin.mode + firstWarningAt — null offset is not call 0", () => {
  const activity = activityFromInbox({
    candidates: [
      {
        id: "req_loop",
        program: { name: "search_to_write", origin: { mode: "loop", firstWarningAt: 3 } },
        verdict: "pending",
        created_at: 1,
      },
      {
        id: "req_row",
        program: { name: "fetch" },
        origin: { mode: "fail_streak", firstWarningAt: 0 },
        verdict: "pending",
        created_at: 2,
      },
      {
        id: "req_null",
        program: { name: "brief", origin: { mode: "low_gain", firstWarningAt: null } },
        verdict: "pending",
        created_at: 3,
      },
    ],
  });
  expect(activity.requests.find((item) => item.id === "req_loop")).toMatchObject({
    failureMode: "loop",
    firstWarningAt: 3,
  });
  expect(activity.requests.find((item) => item.id === "req_row")).toMatchObject({
    failureMode: "fail_streak",
    firstWarningAt: 0,
  });
  const missing = activity.requests.find((item) => item.id === "req_null");
  expect(missing?.failureMode).toBe("low_gain");
  expect(missing?.firstWarningAt).toBeUndefined();
  const status = Object.fromEntries(inboxItems(activity).map((item) => [item.id, item.status]));
  expect(status["request:req_loop"]).toBe("Loop · from call 3");
  expect(status["request:req_row"]).toBe("Fail streak · from call 0");
  expect(status["request:req_null"]).toBe("Low gain");
  expect(status["request:req_null"]).not.toMatch(/from call 0/);
});

test("receiptSeries buckets last 7 local days and ignores seed tools", () => {
  const now = new Date(2026, 7, 20, 15, 0, 0).getTime();
  const start = new Date(2026, 7, 14, 12, 0, 0).getTime();
  const series = receiptSeries(
    [
      { tool_id: "live_notify", created_at: now, ok: 1 },
      { tool_id: "wf_real", created_at: now, ok: 1 },
      { tool_id: "wf_real", created_at: start, ok: 1 },
      { tool_id: "wf_real", created_at: start - 86_400_000, ok: 1 },
    ],
    now,
  );
  expect(series).toHaveLength(7);
  expect(series[0]).toEqual({ label: "Fri", runs: 1 });
  expect(series[6]).toEqual({ label: "Thu", runs: 1 });
  expect(series.slice(1, 6).every((point) => point.runs === 0)).toBe(true);
});

test("dcPct is null until a receipt carries tokenClasses — never a fake 40%", () => {
  const now = new Date(2026, 7, 20, 15, 0, 0).getTime();
  const start = new Date(2026, 7, 14, 12, 0, 0).getTime();
  const inbox: InboxSlice = {
    live: [{ id: "wf_real", name: "notify", state: "live", stats: { n: 2 }, updated_at: now }],
  };
  const without = activityFromInbox(
    inbox,
    [
      { tool_id: "wf_real", created_at: now, ok: 1 },
      { tool_id: "live_notify", created_at: now, tokenClasses: { compiled: 9, frontier: 1 } },
    ],
    now,
  );
  expect(without.dcPct).toBeNull();
  expect(without.dcSeries.every((point) => point.measured === false && point.dcPct === 0)).toBe(true);
  expect(formatDcPct(without.dcPct)).toBe("—");
  expect(formatDcPct(0)).toBe("0%");
  expect(formatDcPct(12.4)).toBe("12%");

  const withClasses = activityFromInbox(
    inbox,
    [
      {
        tool_id: "wf_real",
        created_at: start,
        tokenClasses: { compiled: 4, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 4, providerCache: 800 },
      },
      {
        tool_id: "wf_real",
        created_at: now,
        tokenClasses: { compiled: 1, memoized: 0, transparent: 0, steeredSkip: 1, frontier: 0 },
      },
    ],
    now,
  );
  expect(withClasses.dcSeries).toHaveLength(7);
  expect(withClasses.dcSeries[0]).toEqual({ label: "Fri", dcPct: 50, measured: true });
  expect(withClasses.dcSeries[6]).toEqual({ label: "Thu", dcPct: 100, measured: true });
  expect(withClasses.dcSeries.slice(1, 6).every((point) => point.measured === false && point.dcPct === 0)).toBe(true);
  // Window share: compiled 5 + steeredSkip 1 over frontier 4 → 6/10. Cache ignored.
  expect(withClasses.dcPct).toBe(60);
  expect(formatDcPct(withClasses.dcPct)).toBe("60%");
});

test("last receipt remainder skip / host-drop use failLabel words; Live/Paused stay", () => {
  expect(lastReceiptKind({ ok: 1, tokenClass: "steered-skip", skipped: ["Grep"] })).toBe(failLabel("skipped"));
  expect(lastReceiptKind({ ok: 1, skipped: ["Bash"] })).toBe(failLabel("skipped"));
  expect(
    lastReceiptKind({
      reason: "Already served by pr_summary. Do not re-run Grep — the remaining steps of this routine are in the last tool output.",
    }),
  ).toBe(failLabel("skipped"));
  expect(
    lastReceiptKind({
      ok: 1,
      skipped: ["Read"],
      outcome: "degraded",
      reason: "The host dropped the rewrite (updatedToolOutput). Original tool output was kept.",
    }),
  ).toBe(failLabel("degraded"));
  expect(lastReceiptKind({ ok: 1, outcome: "ok" })).toBeNull();
  expect(lastReceiptKind({ ok: 1, outcome: "degraded", reason: "capacity: session full (64/64), this stretch ran raw" })).toBeNull();
  expect(lastReceiptKind({ ok: 0, skipped: ["check"], outcome: "skipped" })).toBeNull();
  expect(lastReceiptKind(null)).toBeNull();
});

test("Home names the whole stretch — a later skip does not hide a drop", () => {
  const now = 1_700_000_000_000;
  const inbox: InboxSlice = {
    live: [
      { id: "wf_stretch", name: "notify", state: "live", stats: { n: 3, fail: 0 }, updated_at: now },
      { id: "wf_skip", name: "skip_only", state: "live", stats: { n: 1, fail: 0 }, updated_at: now },
      { id: "wf_drop", name: "fetch", state: "paused", stats: { n: 1, fail: 0 }, updated_at: now },
    ],
  };
  const activity = activityFromInbox(
    inbox,
    [
      { tool_id: "wf_stretch", created_at: now - 2000, ok: 1, tokenClass: "transparent", outcome: "ok" },
      {
        tool_id: "wf_stretch",
        created_at: now - 1000,
        ok: 1,
        outcome: "degraded",
        reason: "The host dropped the rewrite (updatedToolOutput). Original tool output was kept.",
      },
      { tool_id: "wf_stretch", created_at: now, ok: 1, tokenClass: "steered-skip", skipped: ["Grep"] },
      { tool_id: "wf_skip", created_at: now, ok: 1, tokenClass: "steered-skip", skipped: ["Grep"] },
      {
        tool_id: "wf_drop",
        created_at: now,
        ok: 1,
        reason: "The host dropped the rewrite (updatedToolOutput). Original tool output was kept.",
      },
    ],
    now,
  );
  expect(activity.fails).toBe(0);
  expect(activity.dcPct).toBeNull();
  const stretch = activity.workflows.find((w) => w.id === "wf_stretch");
  expect(stretch?.stretchWords).toEqual(["Served", "Skipped", "Degraded"]);
  expect(workflowStatus("live", stretch?.stretchWords)).toBe("Live · Served · Skipped · Degraded");
  const items = inboxItems(activity);
  expect(items.map((item) => [item.name, item.status])).toEqual([
    ["notify", "Live · Served · Skipped · Degraded"],
    ["skip_only", "Live · Skipped"],
    ["fetch", "Paused · Degraded"],
  ]);
  expect(items[0]?.status).not.toBe("Live · Skipped");
  expect(items[0]?.status).toContain("Degraded");
  expect(items.every((item) => !/already served|last tool output|kept the original|Facts are still/i.test(item.status))).toBe(
    true,
  );
  expect(items.every((item) => !/\d+%/.test(item.status) && !/\d+ skip/i.test(item.status))).toBe(true);
});

test("Home names a cache hit in words when the latest receipt looked up the cache", () => {
  const now = 1_700_000_000_000;
  const inbox: InboxSlice = {
    live: [
      { id: "wf_hit", name: "lookup", state: "live", stats: { n: 2, fail: 0 }, updated_at: now },
      { id: "wf_quiet", name: "quiet", state: "live", stats: { n: 1, fail: 0 }, updated_at: now },
    ],
  };
  const activity = activityFromInbox(
    inbox,
    [
      { tool_id: "wf_hit", created_at: now, ok: 1, cache_lookups: 4, cache_hits: 3 },
      { tool_id: "wf_quiet", created_at: now, ok: 1, outcome: "ok" },
    ],
    now,
  );
  expect(activity.dcPct).toBeNull();
  expect(inboxItems(activity).map((item) => [item.name, item.status])).toEqual([
    ["lookup", "Live · Served · cached this run"],
    ["quiet", "Live · Served"],
  ]);
  expect(inboxItems(activity).every((item) => !/\d+ of \d+/.test(item.status))).toBe(true);
});

test("a successful remainder does not look like a failed tool and does not invent DC%", () => {
  const inbox: InboxSlice = {
    live: [{ id: "wf_1", name: "pr_summary", state: "live", stats: { n: 4, fail: 0 }, updated_at: 40 }],
  };
  const activity = activityFromInbox(inbox, [
    { tool_id: "wf_1", created_at: 40, ok: 1, skipped: ["Grep", "Bash"], tokenClass: "steered-skip" },
  ]);
  expect(activity.fails).toBe(0);
  expect(activity.dcPct).toBeNull();
  expect(activity.workflows[0]?.lastKind).toBe("Skipped");
  expect(inboxItems(activity)[0]?.status).toBe("Live · Skipped");
  expect(inboxItems(activity)[0]?.status).not.toMatch(/Failed|Refused/);
});

test("empty fleet strip is — not a fake share", () => {
  const empty = activityFromInbox(null);
  expect(empty.fleet).toEqual({ agents: [], fleetDcPct: null, sharedLine: null });
  expect(formatDcPct(null)).toBe("—");
  expect(failureModeLabel("handoff")).toBe("Handoff");
  expect(failureModeLabel("compose")).toBe("Compose");
});

test("fleet strip names shared across N agents and parent/child ids", () => {
  const now = 1_700_000_000_000;
  const inbox: InboxSlice = {
    live: [{ id: "wf_1", name: "fetch", state: "live", stats: { n: 2 }, updated_at: now }],
  };
  const activity = activityFromInbox(
    inbox,
    [
      {
        tool_id: "wf_1",
        created_at: now - 1000,
        ok: 1,
        agentId: "orch",
        fleetId: "f1",
        region: "us-east-1",
        tokenClasses: { compiled: 4, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 1 },
      },
      {
        tool_id: "wf_1",
        created_at: now,
        ok: 1,
        agentId: "intake",
        parentRunId: "run-parent",
        fleetId: "f1",
        region: "us-east-1",
        sharedAcross: 2,
        reason: "shared across 2 agents",
        tokenClasses: { compiled: 0, memoized: 0, transparent: 0, steeredSkip: 2, frontier: 0 },
      },
    ],
    now,
  );
  expect(activity.fleet?.sharedLine).toBe("shared across 2 agents");
  expect(activity.fleet?.region).toBe("us-east-1");
  expect(activity.fleet?.agents.map((a) => [a.id, a.parentRunId ?? null, a.dcPct != null])).toEqual([
    ["intake", "run-parent", true],
    ["orch", null, true],
  ]);
  expect(activity.fleet?.fleetDcPct).not.toBeNull();
  expect(formatDcPct(activity.fleet?.fleetDcPct)).not.toBe("—");
  expect(lastReceiptKind({ ok: 1, sharedAcross: 2, reason: "shared across 2 agents" })).toBe("Skipped");
  expect(inboxItems(activity)[0]?.status).toContain("shared across 2 agents");
});

test("Home status adds Canary and Zero-LLM only when those flags are set", () => {
  expect(workflowStatus("live", [])).toBe("Live");
  expect(workflowStatus("live", [], null, null, "canary", true)).toBe("Canary · Zero-LLM");
  expect(workflowStatus("live", ["Served"], null, null, "canary")).toBe("Canary · Served");
  const activity = activityFromInbox({
    live: [
      {
        id: "wf_canary",
        name: "notify",
        state: "live",
        stats: { n: 1, fail: 0 },
        updated_at: 1,
        rollout: "canary",
        program: { steps: [{ kind: "tool" }] },
      },
      {
        id: "wf_island",
        name: "draft",
        state: "live",
        stats: { n: 1, fail: 0 },
        updated_at: 2,
        program: { steps: [{ kind: "island", pinned: false }] },
      },
    ],
  });
  expect(activity.workflows.find((w) => w.id === "wf_canary")?.rollout).toBe("canary");
  expect(activity.workflows.find((w) => w.id === "wf_canary")?.zeroLlm).toBe(true);
  expect(activity.workflows.find((w) => w.id === "wf_island")?.zeroLlm).toBeUndefined();
  expect(inboxItems(activity).map((item) => [item.name, item.status])).toEqual([
    ["draft", "Live"],
    ["notify", "Canary · Zero-LLM"],
  ]);
  expect(statusTone("Canary · Zero-LLM")).toBe("live");
  expect(statusTone("Canary")).toBe("live");
  expect(statusTone("Live")).toBe("live");
  expect(statusTone("Paused")).toBe("wait");
  expect(statusTone("Ready")).toBe("ready");
  expect(workflowServing([{ state: "live", rollout: "canary" }])).toEqual({ n: 1, canary: 1, live: 0 });
  expect(workflowServing([{ state: "live" }, { state: "live", rollout: "canary" }])).toEqual({
    n: 2,
    canary: 1,
    live: 1,
  });
});

