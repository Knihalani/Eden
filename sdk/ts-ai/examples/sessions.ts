/**
 * Example: F23 agent sessions — begin → traces → complete.
 */

import { begin, identify, configure } from "../src/index.js";

configure({
  orgId: "org_demo",
  apiKey: "sk_eden_demo",
  disabled: true,
});

const session = await begin({ agentId: "support-bot", userId: "user_1" });
await identify("user_1");
await session.trace("turn-1", async () => {
  session.addCost(0.0012);
  return "ok";
});
await session.completeSession(true);

console.log("sessionId=", session.sessionId);
console.log("traces=", session.traceIds);
console.log("costUsd=", session.costUsd);
