/**
 * The known-formatted set's key (scripts/format.sh, D819): the cold gate trusts the set, so the key must change with
 * everything that decides Prettier's verdict. Each case edits one input in a scratch repository and expects a new key.
 */
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "format.sh");

function repo(): { dir: string; key: () => string; write: (path: string, text: string) => void } {
  const dir = mkdtempSync(join(tmpdir(), "eden-format-key-"));
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  mkdirSync(join(dir, "scripts"));
  copyFileSync(script, join(dir, "scripts/format.sh"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  write("node_modules/prettier/package.json", '{\n  "name": "prettier",\n  "version": "3.9.9",\n}\n');
  write(".gitignore", "node_modules/\n");
  write("package.json", '{ "name": "x" }\n');
  write("bun.lock", "{}\n");
  write(".prettierrc", '{ "printWidth": 120 }\n');
  write(".prettierignore", "archived/\n");
  write(".editorconfig", "root = true\n");
  write("packages/a/package.json", '{ "name": "a" }\n');
  write("src/x.ts", "export const x = 1;\n");
  const key = () => {
    const r = Bun.spawnSync(["bash", "scripts/format.sh", "--key"], { cwd: dir });
    expect(r.exitCode).toBe(0);
    return r.stdout.toString().trim();
  };
  return { dir, key, write };
}

describe("format.sh's key (D819)", () => {
  test("is stable, and names the set it keys", () => {
    const r = repo();
    expect(r.key()).toMatch(/^prettier-[0-9a-f]{40,64}$/);
    expect(r.key()).toBe(r.key());
  });

  const edits: [string, string, string][] = [
    [
      "Prettier's version",
      "node_modules/prettier/package.json",
      '{\n  "name": "prettier",\n  "version": "3.9.10",\n}\n',
    ],
    [".prettierrc", ".prettierrc", '{ "printWidth": 100 }\n'],
    [".prettierignore", ".prettierignore", "archived/\nbench/\n"],
    [".editorconfig", ".editorconfig", "root = true\n[*]\nindent_size = 4\n"],
    ["the root package.json (a prettier key or a plugin)", "package.json", '{ "name": "x", "prettier": {} }\n'],
    ["a package's package.json", "packages/a/package.json", '{ "name": "a", "prettier": {} }\n'],
    ["bun.lock (a plugin's version)", "bun.lock", '{ "prettier-plugin-x": "1.0.1" }\n'],
    ["a new config file", "packages/a/.prettierrc.json", "{}\n"],
    ["a prettier.config file", "prettier.config.mjs", "export default {};\n"],
  ];
  for (const [what, path, text] of edits) {
    test(`changes with ${what}`, () => {
      const r = repo();
      const before = r.key();
      r.write(path, text);
      expect(r.key()).not.toBe(before);
    });
  }

  test("does not change with a source file: that is the set's own entry", () => {
    const r = repo();
    const before = r.key();
    r.write("src/x.ts", "export const x = 2;\n");
    expect(r.key()).toBe(before);
  });
});
