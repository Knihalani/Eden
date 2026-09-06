import { describe, expect, test } from "bun:test";
import { liveInvoiceStatus, parseInvoice } from "./invoice";

describe("invoice parse", () => {
  test("missing file retires the live-invoice claim", () => {
    const cell = parseInvoice(null);
    expect(cell.source).toBe("missing");
    expect(liveInvoiceStatus(cell)).toBe("retired");
    expect(parseInvoice("").source).toBe("missing");
  });

  test("TURN_CENTS analogue is never live-invoice", () => {
    const cell = parseInvoice(JSON.stringify({ cents: 3.0, note: "TURN_CENTS=1 analogue" }));
    expect(cell.source).toBe("analogue-headless");
    expect(liveInvoiceStatus(cell)).toBe("retired");
    expect(cell.cents).toBe(3);
  });

  test("provider usage JSON is live-invoice", () => {
    const cell = parseInvoice(JSON.stringify({ cost_usd: 1.25, usage: { input_tokens: 800, output_tokens: 40 } }));
    expect(cell.source).toBe("live-invoice");
    expect(liveInvoiceStatus(cell)).toBe("measured");
    expect(cell.cents).toBe(125);
  });
});
