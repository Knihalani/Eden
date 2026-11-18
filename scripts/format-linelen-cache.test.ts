/**
 * The line-length pass's verdict set (scripts/format.sh, the linelen-* file under eden-check-cache): a warm
 * --check hands the checker only the files whose content it has not passed. Each run happens in a scratch
 * repository with a stub Prettier (exit 0) and a stub checker that logs the paths it was given, so the test reads
 * the shell plumbing, not the tools.
 */
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "format.sh");

function repo(): {
  dir: string;
  check: () => { code: number; out: string };
  checked: () => string[];
  write: (path: string, text: string) => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "eden-linelen-cache-"));
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  mkdirSync(join(dir, "scripts"));
  copyFileSync(script, join(dir, "scripts/format.sh"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  write("node_modules/prettier/package.json", '{\n  "name": "prettier",\n  "version": "3.9.9",\n}\n');
  write("node_modules/prettier/bin/prettier.cjs", "process.exit(0);\n");
  write(".gitignore", "node_modules/\n");
  write("package.json", '{ "name": "x" }\n');
  write("bun.lock", "{}\n");
  write(".prettierrc.json", '{ "printWidth": 120 }\n');
  // Records the paths it was handed, one run's worth per line, and passes.
  write(
    "scripts/check-line-length.ts",
    'import { appendFileSync } from "node:fs";\n' +
      'appendFileSync("ll-args.txt", process.argv.slice(2).join(" ") + "\\n");\n',
  );
  write("src/a.ts", "export const a = 1;\n");
  write("src/b.ts", "export const b = 1;\n");
  const check = () => {
    const r = Bun.spawnSync(["bash", "scripts/format.sh", "--check"], { cwd: dir });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  const checked = () => readFileSync(join(dir, "ll-args.txt"), "utf8").trim().split("\n");
  return { dir, check, checked, write };
}

describe("format.sh's line-length set", () => {
  test("a warm run skips files whose content already passed", () => {
    const r = repo();
    expect(r.check().code).toBe(0);
    expect(r.checked()).toEqual(["scripts/check-line-length.ts src/a.ts src/b.ts"]);

    const second = r.check();
    expect(second.code).toBe(0);
    expect(second.out).toContain("already known within the limit");
    // The checker was not run again.
    expect(r.checked()).toEqual(["scripts/check-line-length.ts src/a.ts src/b.ts"]);
  });

  test("rechecks only the file whose content changed", () => {
    const r = repo();
    expect(r.check().code).toBe(0);
    r.write("src/a.ts", "export const a = 2;\n");
    expect(r.check().code).toBe(0);
    expect(r.checked()).toEqual(["scripts/check-line-length.ts src/a.ts src/b.ts", "src/a.ts"]);
    // And the new content is cached too.
    expect(r.check().out).toContain("already known within the limit");
  });

  test("a failure remembers nothing, not even the files that passed", () => {
    const r = repo();
    // The stub fails while any checked file holds the marker.
    r.write(
      "scripts/check-line-length.ts",
      'import { appendFileSync, readFileSync } from "node:fs";\n' +
        'appendFileSync("ll-args.txt", process.argv.slice(2).join(" ") + "\\n");\n' +
        'const m = "TOO" + "LONG";\n' +
        'if (process.argv.slice(2).some((p) => readFileSync(p, "utf8").includes(m))) process.exit(1);\n',
    );
    r.write("src/a.ts", "export const a = 1; // TOOLONG\n");
    expect(r.check().code).toBe(1);
    // A second failing run hands the checker every file again: src/b.ts passed inside the first run, but the run's
    // failure kept it out of the set.
    expect(r.check().code).toBe(1);
    expect(r.checked()).toEqual([
      "scripts/check-line-length.ts src/a.ts src/b.ts",
      "scripts/check-line-length.ts src/a.ts src/b.ts",
    ]);
    r.write("src/a.ts", "export const a = 2;\n");
    expect(r.check().code).toBe(0);
    expect(r.check().out).toContain("already known within the limit");
  });

  test("FORMAT_COLD=1 checks every file and remembers nothing", () => {
    const r = repo();
    expect(r.check().code).toBe(0);
    const cold = Bun.spawnSync(["bash", "scripts/format.sh", "--check"], {
      cwd: r.dir,
      env: { ...process.env, FORMAT_COLD: "1" },
    });
    expect(cold.exitCode).toBe(0);
    expect(r.checked()).toEqual([
      "scripts/check-line-length.ts src/a.ts src/b.ts",
      "scripts/check-line-length.ts src/a.ts src/b.ts",
    ]);
  });
});
