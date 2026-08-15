/**
 * Every `eden-*` class used in markup must have a CSS rule behind it.
 *
 * `eden-skeleton-pulse` was applied 25 times across four files -- both
 * route-level `loading.tsx` shells, the auth loading shell and the invite
 * panel -- and was defined nowhere. All of those skeletons rendered as flat,
 * motionless blocks. Nothing anywhere reported a problem, because an
 * undefined class name is not an error: not in CSS, not in Tailwind, and not
 * in TypeScript, which sees `className` as a plain string. The only signal was
 * visual, on loading states that are by definition transient.
 *
 * That is the bug class this file exists for, not the single instance. The
 * `eden-` prefix marks the project's own hand-written CSS, so a token with
 * that prefix and no rule is always a mistake -- either a typo or a rule that
 * was deleted while its usages stayed.
 *
 * Scope is deliberately narrow, because getting it wrong in the other
 * direction makes the gate useless:
 *
 * - **Only `className` attributes.** A first pass grepping for `eden-`
 *   anywhere flagged 25 "violations", nearly all of them legitimate non-CSS
 *   identifiers: the `eden-plausible-script` DOM id, `eden-export-` API
 *   resource prefixes, `eden-portal-shell` tour anchors. A gate that noisy
 *   gets muted.
 * - **Only the `eden-` prefix.** Tailwind utilities are generated, not
 *   authored, so requiring rules for them would flag every class in the app.
 *
 * Unused-but-defined is not checked. It is harmless, and a rule can legitimately
 * be referenced from another rule's `animation` shorthand rather than from
 * markup.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "_archive") continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * Pulls class tokens out of the four `className=` spellings actually used in
 * this codebase: a plain string, a template literal, a braced string, and a
 * template literal opening a conditional expression.
 */
const CLASSNAME_RE =
  /className\s*=\s*(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\}|\{\s*`([^`]*)`)/g;
const EDEN_TOKEN = /^eden-[a-z0-9-]+$/;

interface Usage {
  cls: string;
  files: string[];
}

function collect(): { used: Usage[]; defined: Set<string> } {
  const files = walk(SRC);
  const usage = new Map<string, Set<string>>();

  for (const file of files) {
    if (!/\.(tsx|jsx)$/.test(file)) continue;
    if (/\.test\.(tsx|jsx)$/.test(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(CLASSNAME_RE)) {
      const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
      // Split on whitespace and on the punctuation that separates tokens
      // inside template literals and ternaries.
      for (const token of value.split(/[\s${}()?:]+/)) {
        if (!EDEN_TOKEN.test(token)) continue;
        if (!usage.has(token)) usage.set(token, new Set());
        usage.get(token)!.add(path.relative(SRC, file));
      }
    }
  }

  const css = files
    .filter((f) => f.endsWith(".css"))
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n");

  const defined = new Set<string>();
  for (const match of css.matchAll(/\.(eden-[a-z0-9-]+)/g)) {
    defined.add(match[1]);
  }

  return {
    used: [...usage.entries()].map(([cls, files]) => ({
      cls,
      files: [...files].sort(),
    })),
    defined,
  };
}

describe("custom eden-* classes", () => {
  it("are all defined in CSS", () => {
    const { used, defined } = collect();
    const missing = used
      .filter((u) => !defined.has(u.cls))
      .map((u) => `${u.cls} (used in ${u.files.join(", ")})`)
      .sort();

    expect(
      missing,
      "These class names are applied in markup but no CSS rule defines them, " +
        "so they render as nothing at all. An undefined class is silent in " +
        "CSS, in Tailwind and in TypeScript — the only way it surfaces is " +
        "somebody noticing the element looks wrong.",
    ).toEqual([]);
  });

  it("finds the classes it is supposed to be checking", () => {
    // Without this, deleting the extraction regex would make the gate above
    // pass trivially forever.
    const { used, defined } = collect();
    expect(used.length).toBeGreaterThanOrEqual(10);
    expect(defined.size).toBeGreaterThanOrEqual(10);
    expect(used.map((u) => u.cls)).toContain("eden-skeleton-pulse");
  });

  it("keeps the skeleton pulse animated", () => {
    // The instance that motivated the gate. Named explicitly so that
    // deleting the rule fails with a message about skeletons rather than a
    // generic list.
    const css = fs.readFileSync(
      path.join(SRC, "styles", "components.css"),
      "utf8",
    );
    expect(css).toMatch(/@keyframes\s+eden-skeleton-pulse/);
    expect(css).toMatch(/\.eden-skeleton-pulse\s*\{[^}]*animation:/);
  });
});
