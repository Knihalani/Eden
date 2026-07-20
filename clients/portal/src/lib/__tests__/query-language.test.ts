import { describe, expect, it } from "vitest";
import {
  parseQueryLanguage,
  serializeQueryLanguage,
  suggestQueryCompletions,
  parsedToSpanSearchParams,
} from "@/lib/query-language";

describe("parseQueryLanguage", () => {
  it("parses agent and status tokens", () => {
    const parsed = parseQueryLanguage("agent:support status:error");
    expect(parsed.agent_id).toBe("support");
    expect(parsed.outcome).toBe("failure");
  });

  it("parses quoted text", () => {
    const parsed = parseQueryLanguage('text:"command not found"');
    expect(parsed.text).toBe("command not found");
  });

  it("parses cost:> filters", () => {
    const parsed = parseQueryLanguage("cost:>0.05 agent:support");
    expect(parsed.cost_gt_usd).toBe(0.05);
    expect(parsed.agent_id).toBe("support");
  });

  it("round-trips via serialize", () => {
    const q = serializeQueryLanguage({
      agent_id: "bot",
      outcome: "failure",
      tag: "prod",
    });
    const parsed = parseQueryLanguage(q);
    expect(parsed.agent_id).toBe("bot");
    expect(parsed.outcome).toBe("failure");
    expect(parsed.tag).toBe("prod");
  });

  it("suggests field completions", () => {
    expect(suggestQueryCompletions("lat").some((s) => s.label === "latency")).toBe(true);
  });

  it("maps parsed filters to span search params", () => {
    const params = parsedToSpanSearchParams(
      parseQueryLanguage("agent:bot status:error hello world"),
    );
    expect(params.agent).toBe("bot");
    expect(params.outcome).toBe("failure");
    expect(params.q).toContain("hello");
  });
});
