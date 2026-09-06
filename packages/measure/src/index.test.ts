import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as measure from "./index";

describe("measure barrel", () => {
  test("does not re-export the Node fs publication scanner into product clients", () => {
    expect("scanPublicFiles" in measure).toBe(false);
    expect("PUBLIC_COPY_PATHS" in measure).toBe(false);
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(src).not.toMatch(/publish-check/);
    expect(src).not.toMatch(/node:fs/);
  });

  test("still exports stretch words, digest, and waste rank for Home", () => {
    expect(typeof measure.stretchWords).toBe("function");
    expect(typeof measure.renderDigestText).toBe("function");
    expect(typeof measure.dcPct).toBe("function");
    expect(typeof measure.rankByWaste).toBe("function");
  });
});
