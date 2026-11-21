import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const text = readFileSync(new URL("./alerts.yaml", import.meta.url), "utf8");

/** The yaml block of one alert rule, or "" when no rule of that name is in the file. */
function rule(name: string): string {
  const m = new RegExp(`- alert: ${name}\\n([\\s\\S]*?)(?=\\n      - alert:|\\n  - name:|$)`).exec(text);
  return m?.[0] ?? "";
}

describe("the fleet SLO alerts (D2047, s1-scale-1m.md §8)", () => {
  // Each row of §8 that the file covers: the alert, a phrase its expression must hold, and its severity.
  const slo: [string, string, string][] = [
    ["EdenSlowEvents", 'eden_request_seconds_bucket{route="/v1/events"}', "warn"],
    ["EdenErrors", 'eden_requests_total{status=~"5.."}', "page"],
    ["EdenFirstValueSlow", "eden_sync_first_value_seconds_bucket", "warn"],
    ["EdenBackfillBacklog", "eden_sync_users_waiting_first_page", "warn"],
    ["EdenConnectorThrottled", "eden_sync_listing_throttled_total", "warn"],
    ["EdenKickStarving", "eden_sync_kick_queue_users", "warn"],
    ["EdenMemoryFull", "node_memory_MemAvailable_bytes", "warn"],
  ];
  test.each(slo)("%s watches %s at severity %s", (name, phrase, severity) => {
    const r = rule(name);
    expect(r).toContain(phrase);
    expect(r).toContain(`severity: ${severity}`);
    expect(r).toMatch(/for: \d+m/);
  });

  test("EdenFirstValueSlow measures time to first value against the §8 bound", () => {
    const r = rule("EdenFirstValueSlow");
    expect(r).toContain("histogram_quantile(0.9");
    expect(r).toContain("> 900"); // p90 over 15 min (the SLO is 5 min; the alert is 3x it, as §8 says)
  });

  test("EdenConnectorThrottled compares throttled with made listing calls", () => {
    const r = rule("EdenConnectorThrottled");
    expect(r).toContain("eden_sync_listing_calls_total");
    expect(r).toContain("> 0.05");
  });
});
