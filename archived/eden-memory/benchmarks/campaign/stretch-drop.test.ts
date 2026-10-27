/**
 * Wave 8 rotation: 3-call serve + drop + skip. Home must name Degraded
 * even when the latest receipt is a remainder skip.
 *
 * Pre-registered expect: `EXPECT` in stretch-drop.ts.
 * Do not retune silent-drop.ts against this world.
 */
import { describe, expect, test } from "bun:test";
import { stretchWords } from "@eden/measure";
import { activityFromInbox, inboxItems, workflowStatus } from "../../apps/web/app/home/activity";
import { EXPECT, stretchDropInbox, stretchDropReceipts, stretchDropWords } from "./stretch-drop";

describe("rotation: stretch-drop (Wave 8)", () => {
  test("3-call stretch names Served + Skipped + Degraded on Home", () => {
    // Pre-registered: stretchWords === ["Served","Skipped","Degraded"]
    // Home status `Live · Served · Skipped · Degraded` (not merely Skipped).
    expect(EXPECT).toContain("Degraded");
    const receipts = stretchDropReceipts();
    expect(stretchWords(receipts)).toEqual(["Served", "Skipped", "Degraded"]);
    expect(stretchDropWords()).toEqual(["Served", "Skipped", "Degraded"]);
    expect(receipts.at(-1)).toMatchObject({ tokenClass: "steered-skip" });

    const activity = activityFromInbox(stretchDropInbox(), receipts);
    expect(activity.workflows[0]?.stretchWords).toEqual(["Served", "Skipped", "Degraded"]);
    expect(workflowStatus("live", activity.workflows[0]?.stretchWords)).toBe("Live · Served · Skipped · Degraded");
    const status = inboxItems(activity)[0]?.status ?? "";
    expect(status).toBe("Live · Served · Skipped · Degraded");
    expect(status).toContain("Degraded");
    expect(status).not.toBe("Live · Skipped");
  });
});
