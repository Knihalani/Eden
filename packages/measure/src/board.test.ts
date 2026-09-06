import { describe, expect, test } from "bun:test";
import { PUBLIC_CLAIMS, claimById } from "./claims";
import { winTableHas } from "./publish-check";
import { boardCounts, boardSummaryLine, parseClaimsKind, renderClaimsBoard } from "./board";

describe("claims board", () => {
  test("summary counts match PUBLIC_CLAIMS kinds", () => {
    const n = boardCounts();
    expect(n.wins).toBe(PUBLIC_CLAIMS.filter((c) => c.kind === "win").length);
    expect(n.customers).toBe(0);
    expect(n.limits).toBeGreaterThanOrEqual(5);
    expect(boardSummaryLine()).toMatch(/0 customers/);
    expect(parseClaimsKind("limits")).toBe("limit");
    expect(parseClaimsKind("")).toBe("all");
    expect(parseClaimsKind("nope")).toBeNull();
  });

  test("letter names limits; win table does not list oblivious-long", () => {
    const letter = renderClaimsBoard();
    expect(letter.startsWith("eden claims — published limits board")).toBe(true);
    expect(letter).toMatch(/Analogue cents are analogue, not a live Claude Code invoice/);
    expect(winTableHas("oblivious-long")).toBe(false);
    expect(claimById("oblivious-long")?.kind).toBe("limit");
    expect(letter).toMatch(/oblivious-long/);
    expect(letter).toMatch(/\+2\.8% cents \/ \+3\.2% wall/);
    expect(letter).toMatch(/FAIL precision=0\.789 n=38/);
    expect(letter).toMatch(/host limit \(replica-only\)/);
    const onlyWins = renderClaimsBoard(undefined, { kind: "win" });
    expect(onlyWins).not.toMatch(/oblivious-long/);
    expect(onlyWins).not.toMatch(/−9\.1%/);
  });
});
