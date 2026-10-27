/** Next/Vercel Node cannot load `bun:sqlite`. Hosted site uses Neon. */
export class Database {
  constructor() {
    throw new Error("bun:sqlite is not available in this runtime");
  }
}
