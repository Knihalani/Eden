#!/usr/bin/env bun
/**
 * `eden <command>` (D852): one entry point for the server's operator commands, so the Docker image and a checkout
 * offer the same names. `eden doctor` checks a tenant's integration (doctor.ts); `eden serve` starts the server
 * (main.ts); `eden trace-report` and `eden digest` read an `EDEN_TRACE=1` log.
 */
const COMMANDS: Record<string, string> = {
  doctor: "./doctor.ts",
  serve: "./main.ts",
  "trace-report": "./trace-report.ts",
  digest: "./digest.ts",
};

const [command, ...rest] = process.argv.slice(2);
const target = command ? COMMANDS[command] : undefined;
if (!target) {
  console.error(`usage: eden <${Object.keys(COMMANDS).join("|")}> [args]`);
  process.exit(2);
}
const proc = Bun.spawn(["bun", new URL(target, import.meta.url).pathname, ...rest], {
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
