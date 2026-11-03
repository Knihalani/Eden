/**
 * Dates read the same on every host: a zone-less date (a sim mail's `Date:` header, a local calendar start) is UTC
 * (`parseWhen`), not the server process's zone. The preload pins TZ=UTC for this process, so the other zones run in
 * child processes: Bun reads TZ once, before the first Date.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ContextItem } from "@eden/protocol";
import { datedOf } from "./cards";
import { sentAt } from "./conflict";
import { parseWhen, startMs } from "./grounding";

const mail = (date: string): ContextItem => ({
  id: "mail:1",
  sourceId: "mail",
  ref: "1",
  title: "Re: offsite",
  text: `From: Ana\nDate: ${date}\n\nSee you there.`,
});

const INPUTS = [
  "Wed, 14 Oct 2026 23:30",
  "14 Oct 2026",
  "14-Oct-2026",
  "2026-10-14T09:00",
  "2026-10-14 09:00:30",
  "2026-10-14",
  "Wed, 14 Oct 2026 09:14:00 +0000",
  "Wed, 14 Oct 2026 09:14:00 -0700",
  "Wed, 14 Oct 2026 09:14:00 PST",
  "2026-10-14T09:00:00+09:00",
  "2026-10-14T09:00:00Z",
  "2026-10-14T09:00:00z",
  "Wed, 14 Oct 2026 09:14:00 GMT+1",
  "2026-10-14t09:00",
  "+002026-10-14T09:00:00",
  "Wed, 14 Oct 2026 09:14:00 CEST",
  "not a date",
];

/** What each input reads as here: parseWhen, and what sentAt, datedOf and startMs make of it. */
function readAll(): unknown[] {
  return INPUTS.map((s) => {
    const it = mail(s.replace(/,/g, ""));
    const ev = { ...it, meta: { start: s } };
    return [s, parseWhen(s), sentAt(it), datedOf(it), startMs(ev)];
  });
}

const here = import.meta.dir;
const script = `
import { datedOf } from ${JSON.stringify(join(here, "cards.ts"))};
import { sentAt } from ${JSON.stringify(join(here, "conflict.ts"))};
import { parseWhen, startMs } from ${JSON.stringify(join(here, "grounding.ts"))};
const INPUTS = ${JSON.stringify(INPUTS)};
const mail = (date) => ({ id: "mail:1", sourceId: "mail", ref: "1", title: "Re: offsite",
  text: "From: Ana\\nDate: " + date + "\\n\\nSee you there." });
console.log(JSON.stringify(INPUTS.map((s) => {
  const it = mail(s.replace(/,/g, ""));
  return [s, parseWhen(s), sentAt(it), datedOf(it), startMs({ ...it, meta: { start: s } })];
})));
`;

async function readIn(tz: string): Promise<unknown[]> {
  const p = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, TZ: tz },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`TZ=${tz}: exit ${code}: ${err}`);
  return JSON.parse(out) as unknown[];
}

describe("parseWhen: zone-less dates are UTC, whatever the host's zone", () => {
  test("zone-less date-times and day-only RFC 2822 dates read as UTC; zones and ISO bare dates as written", () => {
    expect(parseWhen("Wed, 14 Oct 2026 23:30".replace(/,/g, ""))).toBe(Date.UTC(2026, 9, 14, 23, 30));
    expect(parseWhen("14 Oct 2026")).toBe(Date.UTC(2026, 9, 14));
    expect(parseWhen("14-Oct-2026")).toBe(Date.UTC(2026, 9, 14)); // Its "-2026" is a year, not an offset.
    expect(parseWhen("2026-10-14T09:00")).toBe(Date.UTC(2026, 9, 14, 9));
    expect(parseWhen("2026-10-14 09:00:30")).toBe(Date.UTC(2026, 9, 14, 9, 0, 30));
    expect(parseWhen("2026-10-14")).toBe(Date.UTC(2026, 9, 14));
    expect(parseWhen("Wed 14 Oct 2026 09:14:00 -0700")).toBe(Date.UTC(2026, 9, 14, 16, 14));
    expect(parseWhen("Wed 14 Oct 2026 09:14:00 PST")).toBe(Date.UTC(2026, 9, 14, 17, 14));
    expect(parseWhen("2026-10-14T09:00:00+09:00")).toBe(Date.UTC(2026, 9, 14, 0));
    expect(parseWhen("2026-10-14T09:00:00z")).toBe(Date.UTC(2026, 9, 14, 9)); // RFC 3339 allows a lowercase "z".
    expect(parseWhen("Wed 14 Oct 2026 09:14:00 GMT+1")).toBe(Date.UTC(2026, 9, 14, 8, 14)); // A one-digit hour offset.
    // Zone-less forms that a " GMT" suffix breaks reach the wall-clock fallback (run under other zones below).
    expect(parseWhen("2026-10-14t09:00")).toBe(Date.UTC(2026, 9, 14, 9));
    expect(parseWhen("+002026-10-14T09:00:00")).toBe(Date.UTC(2026, 9, 14, 9));
    // A zone name outside RFC 2822 does not parse at all (callers fall back: sentAt and datedOf to updatedAt).
    expect(parseWhen("Wed 14 Oct 2026 09:14:00 CEST")).toBeNaN();
    expect(parseWhen("not a date")).toBeNaN();
    expect(parseWhen("")).toBeNaN();
    expect(datedOf(mail("14 Oct 2026"))).toBe("2026-10-14");
    expect(sentAt(mail("Wed 14 Oct 2026 23:30"))).toBe(Date.UTC(2026, 9, 14, 23, 30));
  });

  test("Asia/Tokyo and America/Los_Angeles read every input as UTC does", async () => {
    // Through JSON, as the children's answers come (NaN reads as null on both sides).
    const utc = JSON.parse(JSON.stringify(readAll())) as unknown[];
    const [tokyo, la] = await Promise.all([readIn("Asia/Tokyo"), readIn("America/Los_Angeles")]);
    expect(await readIn("UTC")).toEqual(utc);
    expect(tokyo).toEqual(utc);
    expect(la).toEqual(utc);
  });

  test("the children really run in their zones", async () => {
    const offset = async (tz: string) => {
      const p = Bun.spawn([process.execPath, "-e", "console.log(new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset())"], {
        env: { ...process.env, TZ: tz },
        stdout: "pipe",
      });
      return Number((await new Response(p.stdout).text()).trim());
    };
    expect(await offset("Asia/Tokyo")).toBe(-540);
    expect(await offset("America/Los_Angeles")).toBe(480);
  });
});
