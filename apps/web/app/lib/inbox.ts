import { wrapFetch } from "@/lib/wrap";
import type { Inbox } from "@/app/lib/types";

export async function readInbox(): Promise<Inbox> {
  const r = await wrapFetch()(new Request("http://127.0.0.1/v1/inbox"));
  if (!r.ok) {
    return {
      connected: false,
      sig: "",
      candidates: [],
      live: [],
      savings: { runs: 0, fail: 0, llmReductionMean: 0, live: 0 },
    };
  }
  return r.json() as Promise<Inbox>;
}
