import { datedText } from "../../../engine/src/days";
import { timeWindow } from "../../../engine/src/grounding";

const now = Date.parse("2026-10-27T09:00:00Z");
for (const r of [
  "Book me a hotel in Edinburgh for 12–14 November for the Brightwater conference.",
  "Book Maya into Camp Kestrel holiday club for 21–23 December, £38 a day.",
  "Put Zoë on primary on-call in PagerDuty for next week, 2–8 Nov.",
  "Book Biscuit into Oakfield Dog Hotel for 19–23 November while we're in Edinburgh.",
  "Book a hire car from Inverness airport for Monday 30 November to Friday 4 December.",
]) {
  const dt = datedText(r, now, 0);
  console.log([...(timeWindow(dt, now, 0)?.days ?? [])].join(","), "|", dt.slice(0, 90));
}
