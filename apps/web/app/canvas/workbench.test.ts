import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const VIEW = readFileSync(join(import.meta.dir, "view.tsx"), "utf8");
const BOARD = readFileSync(join(import.meta.dir, "../home/board.tsx"), "utf8");
const NAV = readFileSync(join(import.meta.dir, "../home/nav.tsx"), "utf8");
const CHROME = readFileSync(join(import.meta.dir, "../home/chrome.tsx"), "utf8");

test("Approve is the crimson signup button; Pause and Resume are verbs, not a second hue", () => {
  expect(VIEW).toMatch(/className="signup signup-compact"/);
  expect(VIEW).toContain("{pending ? \"Shipping…\" : \"Approve\"}");
  expect(VIEW).toContain("{pending ? \"Working…\" : \"Pause\"}");
  expect(VIEW).toContain("{pending ? \"Working…\" : \"Resume\"}");
  expect(VIEW).not.toMatch(/\bochre\b/);
  expect(VIEW).not.toMatch(/\bcoral\b/);
  expect(VIEW).not.toMatch(/#00ffff/i);
});

test("canvas is a method graph with a named hold, not a Hub or Reach explorer", () => {
  expect(VIEW).toContain('aria-label="Method"');
  expect(VIEW).toContain('id="canvas-hold"');
  expect(VIEW).toContain("receiptPostmortem");
  expect(VIEW).toContain("tipLine");
  expect(VIEW + BOARD + NAV).not.toMatch(/Hub|Reach adapter|play\.modiqo|Play URI/);
});

test("empty Home tells the truth and points at wrap", () => {
  expect(BOARD).toContain("Copy this into your agent");
  expect(BOARD).toContain("Empty is true. Metrics stay 0 until wrap records a run.");
  expect(BOARD).toContain("ConnectBanner");
  expect(BOARD).toContain("PLACEHOLDER_ENV");
});

test("product chrome keeps setup in the rail and never invents a second inspect app", () => {
  expect(NAV).toContain("href={SETUP}");
  expect(CHROME).toContain("AppNav");
  expect(CHROME).not.toMatch(/Hub|Reach/);
});
