/**
 * Wave 8.1 CI pin: live-ab protocol, retired live-invoice, host-drop limit.
 *
 *   bun test benchmarks/campaign/live-ab.test.ts
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveInvoiceStatus, parseInvoice } from "@eden/measure";
import { scanPublicFiles } from "@eden/measure/publish-check";
import { HOST_DROP_MD, LIVE_AB_EXPECT, LIVE_AB_MD, LIVE_AB_PROTOCOL, liveS1bCell, readLiveInvoice } from "./live-ab";

const ROOT = join(import.meta.dir);

describe("live-ab study", () => {
  test("protocol is pre-registered (expect field before run)", () => {
    expect(LIVE_AB_PROTOCOL.paired).toBe(true);
    expect(LIVE_AB_PROTOCOL.expect).toBe(LIVE_AB_EXPECT);
    expect(LIVE_AB_PROTOCOL.expect.length).toBeGreaterThan(20);
    expect(LIVE_AB_PROTOCOL.arms).toEqual(["control", "treatment"]);
  });

  test("missing invoice retires the live-S1b cell", () => {
    const prev = process.env.EDEN_LIVE_INVOICE;
    delete process.env.EDEN_LIVE_INVOICE;
    try {
      const cell = readLiveInvoice();
      expect(cell.source).toBe("missing");
      expect(liveInvoiceStatus(cell)).toBe("retired");
      expect(liveS1bCell(cell).status).toBe("retired");
      expect(parseInvoice(null).note).toMatch(/retired/i);
    } finally {
      if (prev === undefined) delete process.env.EDEN_LIVE_INVOICE;
      else process.env.EDEN_LIVE_INVOICE = prev;
    }
  });

  test("analogue file is not live-invoice", () => {
    const analogue = readFileSync(join(ROOT, "SILENT-DROP.md"), "utf8");
    const cell = parseInvoice(analogue);
    expect(cell.source).not.toBe("live-invoice");
    expect(liveInvoiceStatus(cell)).toBe("retired");
    const dir = mkdtempSync(join(tmpdir(), "eden-live-ab-"));
    const tmp = join(dir, "analogue.txt");
    writeFileSync(tmp, "TURN_CENTS=1 ISLAND_CENTS=0.3 analogue headless replica\n");
    try {
      expect(readLiveInvoice(tmp).source).toBe("analogue-headless");
      expect(liveInvoiceStatus(readLiveInvoice(tmp))).toBe("retired");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("HOST-DROP.md records a permanent host limit", () => {
    const text = readFileSync(HOST_DROP_MD, "utf8");
    expect(text).toMatch(/host limit/i);
    expect(text).toMatch(/Live Claude Code cannot ack/i);
    expect(text).toMatch(/Receipt class `host-drop` stays/);
  });

  test("LIVE-AB.md contains the retired live-invoice sentence", () => {
    const text = readFileSync(LIVE_AB_MD, "utf8");
    expect(text).toContain(
      "No live Claude Code invoice file is in the tree. The analogue −9.1% cell is not a live bill. This " +
        "quote is retired until an invoice parses as live-invoice.",
    );
    expect(text).toMatch(/oblivious-long is a limit/i);
  });

  test("publish-check scan of LIVE-AB.md and HOST-DROP.md is empty", () => {
    expect(scanPublicFiles([LIVE_AB_MD, HOST_DROP_MD])).toEqual([]);
  });
});
