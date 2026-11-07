/**
 * `p`, or a rejection with the signal's reason once it aborts: a source that does not watch its signal (an MCP
 * source still connecting: `connect` and `tools/list` take none) cannot hold a listing or a re-read past its deadline
 * (audit A5; a search is bounded the same way by `Singleflight`). A late settle of `p` is ignored.
 */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}
