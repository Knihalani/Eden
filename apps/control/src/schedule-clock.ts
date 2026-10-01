import { wrapTimeoutMs } from "@eden/wrap";
import type { ApiCtx } from "./api";
import { inheritLiveTool } from "./inherit-live";
import { maybeQueueRefresh } from "./refresh";
import { tickDueSchedules } from "./schedule";

/** `0` keeps operator POST /v1/schedule/tick as the only fire. Default on for wrap. */
export const SCHEDULE_CLOCK_ENV = "EDEN_SCHEDULE_CLOCK";

export function scheduleClockEnabled(raw = process.env[SCHEDULE_CLOCK_ENV]): boolean {
  return raw !== "0";
}

/**
 * Minute clock for already-scheduled live tools. Does not invent cron rows.
 * Paused still never fires. Same tick path as POST /v1/schedule/tick.
 */
export function startScheduleClock(
  ctx: ApiCtx,
  opts?: { intervalMs?: number },
): { stop: () => void; intervalMs: number } {
  const intervalMs = opts?.intervalMs ?? 60_000;
  const tick = () => {
    if (!ctx.registry) return;
    void ctx.store
      .enqueue(async () => {
        await tickDueSchedules({
          store: ctx.store,
          registry: ctx.registry!,
          island: ctx.island,
          timeoutMs: wrapTimeoutMs(),
          now: new Date(),
          onOk: (id) => inheritLiveTool(ctx.store, id),
          onDeopt: (id) => {
            void maybeQueueRefresh(ctx, id).catch(() => undefined);
          },
        });
        return undefined;
      })
      .catch(() => undefined);
  };
  const id = setInterval(tick, intervalMs);
  if (typeof id === "object" && id && "unref" in id) (id as NodeJS.Timeout).unref();
  return {
    stop: () => clearInterval(id),
    intervalMs,
  };
}
