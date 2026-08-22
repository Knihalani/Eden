import {
  activityFromInbox,
  EMPTY_ACTIVITY,
  inboxItems,
  receiptSeries,
  requestStatus,
  type InboxSlice,
} from "./activity";
import { expect, test } from "bun:test";

test("empty inbox stays honest zeros", () => {
  const empty = activityFromInbox(null);
  expect(empty.runs).toBe(0);
  expect(empty.compiled).toBe(0);
  expect(empty.waiting).toBe(0);
  expect(empty.fails).toBe(0);
  expect(empty.llmTimes).toBe(0);
  expect(empty.tokensSaved).toBe(0);
  expect(empty.failed).toBe(false);
  expect(empty.workflows).toEqual([]);
  expect(empty.requests).toEqual([]);
  expect(empty.series).toHaveLength(7);
  expect(activityFromInbox({}).runs).toBe(0);
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
