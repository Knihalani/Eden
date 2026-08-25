/** Focused memory probe: what retains memory across 50k calls? */
import { createState, wrapTools } from "../index";

const state = createState({ programs: [] });
const tools = wrapTools(
  { record: async (a: Record<string, unknown>) => ({ len: JSON.stringify(a).length }) },
  state,
);

function snapshot(label: string): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const mb = process.memoryUsage.rss() / 1024 / 1024;
  console.log(
    `${label.padStart(8)} rss=${mb.toFixed(0)}MB traces=${state.traces.length} events=${state.run.events.length} receipts=${state.receipts.length} pulls=${state.pulls}`,
  );
}

snapshot("start");
for (let i = 0; i < 50_000; i++) {
  await tools.record.execute({ n: i, payload: "p".repeat(300), nested: { a: [1, 2, 3] } });
  if (i % 5000 === 4999) snapshot(`${i + 1}`);
}
// What's inside a retained trace? Size sample.
if (state.traces.length) {
  const sizes = state.traces.map((t) => JSON.stringify(t).length);
  const total = sizes.reduce((a, b) => a + b, 0);
  console.log(`retained trace JSON bytes: total=${(total / 1024 / 1024).toFixed(1)}MB avg=${(total / sizes.length).toFixed(0)}B n=${sizes.length}`);
}
