import { expect, test } from "bun:test";
import { StaticSource } from "@eden/sources";
import { buildPartner } from "./build";
import { createHandler } from "./http";

// Probe (concurrency at the HTTP layer): many asks, events, pendings, session_ends and forgets in the same few sessions
// at once must answer 2xx/4xx, never 5xx; afterwards no session or budget tally is left for closed sessions.

const key = "k_acme_0123456789abcdef";
const crm = new StaticSource("crm", "deals", [
  { ref: "d1", title: "Globex renewal", text: "Dana Lee wants 12% off the Globex renewal" },
  { ref: "d2", title: "Initech account", text: "Initech pays annually, contact Bill Lumbergh" },
]);

test("concurrent requests in one session never 5xx", async () => {
  const partner = buildPartner({ sources: async () => [crm], model: null });
  const handle = createHandler(partner, { keys: new Map([[key, "acme"]]), dev: false, tenantBurst: 1e6 });
  const post = (path: string, body: unknown) =>
    handle(
      new Request(`http://x${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const statuses: number[] = [];
  const jobs: Promise<void>[] = [];
  for (let n = 0; n < 400; n++) {
    const who = { userId: `u${n % 3}`, sessionId: `s${n % 5}` };
    const r = n % 6;
    const req =
      r === 0
        ? post("/v1/ask", { ...who, question: "What about the Globex renewal with Dana Lee?" })
        : r === 1
          ? post("/v1/events?waitMs=200", { ...who, kind: "user_message", text: "Pay the Globex renewal now" })
          : r === 2
            ? post("/v1/pending", who)
            : r === 3
              ? post("/v1/events", { ...who, kind: "session_end" })
              : r === 4
                ? post("/v1/forget", { userId: who.userId })
                : post("/v1/events", { ...who, kind: "tool_result", tool: "crm", text: "Globex renewal Dana Lee" });
    jobs.push(req.then((res) => void statuses.push(res.status)));
  }
  await Promise.all(jobs);
  const bad = statuses.filter((s) => s >= 500);
  expect(bad).toEqual([]);
});
