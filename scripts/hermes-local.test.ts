import { expect, test } from "bun:test";
import { join } from "node:path";

const python = [process.env.HERMES_RELEASE_PYTHON, "python3", "python3.11", "python3.12", "python", "py"]
  .filter((name): name is string => Boolean(name))
  .map((name) => Bun.which(name))
  .find(
    (path): path is string =>
      !!path && Bun.spawnSync([path, "-c", "import sys; sys.exit(sys.version_info < (3, 11))"]).exitCode === 0,
  );

test.skipIf(!python && !process.env.HERMES_RELEASE_SMOKE)(
  "Hermes release archive and offline installer",
  () => {
    if (!python) throw new Error("Hermes release smoke requires Python 3.11+");
    const path = join(import.meta.dir, "hermes-local", "test_release.py");
    const proc = Bun.spawnSync([python, path], { timeout: 180_000 });
    const output = proc.stdout.toString() + proc.stderr.toString();
    if (process.env.HERMES_RELEASE_SMOKE) console.log(output.trim());
    expect(proc.exitCode, output).toBe(0);
  },
  190_000,
);
