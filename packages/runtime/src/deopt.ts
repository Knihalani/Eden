export class DeoptError extends Error {
  readonly deopt = true;
  constructor(readonly reason: string) {
    super(`deopt: ${reason}`);
    this.name = "DeoptError";
  }
}

export function isDeopt(err: unknown): err is DeoptError {
  if (err instanceof DeoptError) return true;
  if (!err || typeof err !== "object") return false;
  const rec = err as { deopt?: boolean; name?: string };
  return rec.deopt === true && rec.name === "DeoptError";
}
