import { wrapFetch } from "@/lib/wrap";
import { edenKey } from "../lib/eden-key";
import { activityFromInbox, failedActivity, type Activity, type InboxSlice } from "./activity";

export async function loadActivity(): Promise<Activity> {
  try {
    // Read-only routes stay key-gated; no org binding needed here.
    const headers = { authorization: `Bearer ${edenKey()}` };
    const [inboxRes, receiptRes] = await Promise.all([
      wrapFetch()(new Request("http://eden.local/v1/inbox", { headers })),
      wrapFetch()(new Request("http://eden.local/v1/receipts", { headers })),
    ]);
    if (!inboxRes.ok) return failedActivity();
    const inbox = (await inboxRes.json()) as InboxSlice;
    if (!inbox || typeof inbox !== "object") return failedActivity();
    const receipts = receiptRes.ok ? await readReceipts(receiptRes) : [];
    return activityFromInbox(inbox, receipts);
  } catch {
    return failedActivity();
  }
}

async function readReceipts(res: Response): Promise<unknown[]> {
  try {
    const body = (await res.json()) as { receipts?: unknown };
    return Array.isArray(body.receipts) ? body.receipts : [];
  } catch {
    return [];
  }
}
