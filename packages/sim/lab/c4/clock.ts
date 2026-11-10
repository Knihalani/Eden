// C4 (D432): `bun --preload packages/sim/lab/c4/clock.ts packages/eval/src/cli.ts` runs the eval on 2026-11-07.
// Pins the wall clock to 2026-11-07 12:00 UTC, moving at its normal rate, to test whether the eval reads the date.
const shift = Date.UTC(2026, 10, 7, 12) - Date.now();
const Real = Date;
const now = () => Real.now() + shift;
class Fixed extends Real {
  constructor(...a: any[]) {
    if (a.length === 0) super(now());
    else super(...(a as []));
  }
  static now() {
    return now();
  }
}
(globalThis as any).Date = Fixed;
