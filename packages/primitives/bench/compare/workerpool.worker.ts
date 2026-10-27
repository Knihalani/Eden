/** The workerpool package's worker for pool.compare.ts: the same gate task, registered the way workerpool wants. */
import { sanitize } from "../workers/gate.task";

const libs = process.env.LIBEVAL ?? "/tmp/claude-0/libeval-arch";
const workerpool = (await import(`${libs}/node_modules/workerpool/src/index.js`)) as {
  worker(methods: Record<string, unknown>): void;
};
workerpool.worker({ sanitize, noop: (x: unknown) => x });
