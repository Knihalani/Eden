import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { winTableHas, scanPublicFiles, scanPublicText, PUBLIC_COPY_PATHS } from "./publish-check";

describe("publish-check", () => {
  test("oblivious-long is not in the win table", () => {
    expect(winTableHas("oblivious-long")).toBe(false);
    expect(winTableHas("short-support")).toBe(true);
    expect(winTableHas("s1b-analogue")).toBe(false);
  });

  test("analogue-as-live and uncertified-as-win are findings", () => {
    const bad = scanPublicText(
      "x.md",
      [
        "Live Claude Code billed −9.1% TURN_CENTS.",
        "The analogue −9.1% is a live Claude Code invoice.",
        "The analogue −9.1% is live Claude Code billed TURN_CENTS.",
        "UNCERTIFIED programs win 4× cheaper.",
        "oblivious-long is a WIN on wrap skipRest.",
        "Live Claude Code ack of host-drop.",
        "A billed S1b live Claude Code invoice saved 9%.",
        "Hook remainder −9.1% cents vs raw.",
      ].join("\n"),
    );
    expect(bad.map((f) => f.rule).sort()).toEqual([
      "analogue-as-live",
      "analogue-as-live",
      "analogue-as-live",
      "billed-s1b-invoice",
      "billed-s1b-invoice",
      "oblivious-as-win",
      "replica-drop-as-live-ack",
      "uncertified-as-win",
      "unlabeled-analogue",
      "unlabeled-analogue",
    ]);
  });

  test("honest sentences do not trip", () => {
    const ok = scanPublicText(
      "x.md",
      [
        "Analogue −9.1% cents is not a live Claude Code invoice.",
        "UNCERTIFIED is never a win.",
        "oblivious-long is a limit / loss, retired from the win table.",
        "Live Claude Code cannot ack host-drop; replica-only is a host limit.",
      ].join("\n"),
    );
    expect(ok).toEqual([]);
  });

  test("labelling analogue does not excuse analogue-as-live Claude Code copy", () => {
    const billed = scanPublicText("x.md", "The analogue −9.1% is live Claude Code billed TURN_CENTS.");
    expect(billed.map((f) => f.rule)).toEqual(["analogue-as-live"]);
    const invoice = scanPublicText("x.md", "The analogue −9.1% is a live Claude Code invoice.");
    expect(invoice.map((f) => f.rule).sort()).toEqual(["analogue-as-live", "billed-s1b-invoice"]);
  });

  test("scans the claims module without findings", () => {
    const file = join(import.meta.dir, "claims.ts");
    expect(scanPublicFiles([file])).toEqual([]);
  });

  test("existing public copy in the tree has no findings", () => {
    const root = join(import.meta.dir, "../../..");
    expect(scanPublicFiles(PUBLIC_COPY_PATHS.map((p) => join(root, p)))).toEqual([]);
  });

  test("scans whitepaper, cases, and proof copy without findings", () => {
    const root = join(import.meta.dir, "../../..");
    expect(
      scanPublicFiles([
        join(root, "docs/whitepaper.md"),
        join(root, "docs/cases.md"),
        join(root, "apps/web/app/(notes)/proof/copy.ts"),
      ]),
    ).toEqual([]);
  });
});
