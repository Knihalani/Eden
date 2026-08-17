import { describe, expect, test } from "bun:test";

function oklchToLin(L: number, C: number, h: number) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => Math.min(1, Math.max(0, c)));
}

function y(L: number, C: number, h: number) {
  const [r, g, b] = oklchToLin(L, C, h);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: [number, number, number], b: [number, number, number]) {
  const ya = y(...a);
  const yb = y(...b);
  const hi = Math.max(ya, yb);
  const lo = Math.min(ya, yb);
  return (hi + 0.05) / (lo + 0.05);
}

const nh = 260;
const ah = 32;
const lh = 250;
const bg: [number, number, number] = [0.155, 0.008, nh];
const canvas: [number, number, number] = [0.11, 0.006, nh];
const lift: [number, number, number] = [0.2, 0.008, nh];
const ink: [number, number, number] = [0.97, 0.006, nh];
const muted: [number, number, number] = [0.86, 0.012, nh];
const faint: [number, number, number] = [0.78, 0.01, nh];
const primary: [number, number, number] = [0.78, 0.145, ah];
const onPrimary: [number, number, number] = [0.16, 0.03, ah];
const danger: [number, number, number] = [0.78, 0.15, 18];
const ok: [number, number, number] = [0.82, 0.08, lh];
const onOk: [number, number, number] = [0.16, 0.03, lh];

describe("dark tokens contrast", () => {
  test("body ink on bg, canvas, and lift clears AA", () => {
    expect(ratio(ink, bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(ink, canvas)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(ink, lift)).toBeGreaterThanOrEqual(4.5);
  });

  test("muted and placeholder on surfaces clear AA", () => {
    expect(ratio(muted, bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(muted, canvas)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(muted, lift)).toBeGreaterThanOrEqual(4.5);
  });

  test("coral button text on primary clears AA", () => {
    expect(ratio(primary, onPrimary)).toBeGreaterThanOrEqual(4.5);
  });

  test("danger on canvas clears AA", () => {
    expect(ratio(danger, canvas)).toBeGreaterThanOrEqual(4.5);
  });

  test("faint labels on surfaces clear AA", () => {
    expect(ratio(faint, bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(faint, canvas)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(faint, lift)).toBeGreaterThanOrEqual(4.5);
  });

  test("ice button text on live action clears AA", () => {
    expect(ratio(ok, onOk)).toBeGreaterThanOrEqual(4.5);
  });
});
