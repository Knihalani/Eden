import { wrapFetch } from "@/lib/wrap";
import { activityFromInbox, failedActivity, type Activity, type InboxSlice } from "./activity";

export async function loadActivity(): Promise<Activity> {
  const token = process.env.EDEN_API_KEY || "eden_dev";
  const headers = { authorization: `Bearer ${token}` };
  try {
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
