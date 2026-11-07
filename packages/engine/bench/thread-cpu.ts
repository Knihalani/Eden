/**
 * CPU time of the process's main thread alone (Linux: `/proc/self/task/<pid>/stat`, utime + stime), for benches that
 * move work to worker threads (D216): `process.cpuUsage()` sums every thread, so it cannot say how much the event loop
 * was spared. Clock ticks of 10 ms (`getconf CLK_TCK` 100), so read it over runs of seconds. NaN off Linux.
 */
import { readFileSync } from "node:fs";

const TICK_US = 10_000;

/** Microseconds of CPU the main thread has used so far, or NaN where the kernel does not say. */
export function mainThreadCpuUs(): number {
  try {
    const stat = readFileSync(`/proc/self/task/${process.pid}/stat`, "utf8");
    // Fields after the command name (which may hold spaces, so read past its closing parenthesis): utime is the 14th
    // field of the line, stime the 15th.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(rest[11]) + Number(rest[12])) * TICK_US;
  } catch {
    return Number.NaN;
  }
}
