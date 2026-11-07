/**
 * `bun run pack:client [outDir]`: writes `@eden/client` as a standalone npm package (default `dist/eden-client`), so
 * an agent outside this monorepo can install it (D365). The workspace package exports TypeScript sources and
 * depends on `@eden/protocol` through `workspace:*`, which neither npm nor bun resolves outside the workspace, and
 * Node does not strip types under node_modules. The package is one ESM bundle (the protocol inlined; its only import
 * is `node:crypto`) plus declarations, so Node 18+, Bun and Deno load it and TypeScript sees the same types.
 *
 *   bun run pack:client && cd my-agent && npm install /path/to/Eden/dist/eden-client
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const here = import.meta.dir;
const packages = resolve(here, "..");

/** Builds the package into `out` and returns its path. Throws with the compiler's messages if a step fails. */
export async function packClient(out: string): Promise<string> {
  out = resolve(out);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const built = await Bun.build({
    entrypoints: [join(here, "src/index.ts")],
    target: "node",
    format: "esm",
    outdir: out,
    naming: "index.js",
  });
  if (!built.success) throw new Error(`pack:client: bundle failed: ${built.logs.map(String).join("\n")}`);

  // Declarations for the client and the part of the protocol it names, laid out as types/<package>/*.d.ts.
  const types = join(out, "types");
  const program = ts.createProgram([join(here, "src/index.ts")], {
    declaration: true,
    emitDeclarationOnly: true,
    outDir: types,
    rootDir: packages,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    strict: true,
    types: ["bun"],
    paths: { "@eden/protocol": [join(packages, "protocol/src/index.ts")] },
  });
  const emitted = program.emit();
  const errors = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics].filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    const text = ts.formatDiagnostics(errors, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => packages,
      getNewLine: () => "\n",
    });
    throw new Error(`pack:client: declarations failed:\n${text}`);
  }

  // Node16 resolution needs explicit extensions in ESM declarations, and the protocol is now a sibling folder.
  for (const file of declarationFiles(types)) {
    const from = dirname(file);
    const text = readFileSync(file, "utf8")
      .replace(/(from |import\()"@eden\/protocol"/g, (_m, p: string) => {
        const to = relative(from, join(types, "protocol/src/index.js"));
        return `${p}"${to.startsWith(".") ? to : `./${to}`}"`;
      })
      .replace(/(from |import\()"(\.\.?\/[^"]+?)(?:\.ts)?"/g, (m, p: string, spec: string) =>
        spec.endsWith(".js") ? m : `${p}"${spec}.js"`,
      );
    writeFileSync(file, text);
  }

  const source = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as {
    version: string;
    description: string;
  };
  const manifest = {
    name: "@eden/client",
    version: source.version,
    description: source.description,
    type: "module",
    main: "./index.js",
    types: "./types/client/src/index.d.ts",
    exports: { ".": { types: "./types/client/src/index.d.ts", default: "./index.js" } },
    engines: { node: ">=18" },
    license: "SEE LICENSE IN LICENSE",
  };
  writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  cpSync(join(packages, "..", "LICENSE"), join(out, "LICENSE"));
  writeFileSync(
    join(out, "README.md"),
    "# @eden/client\n\nBuilt by `bun run pack:client` from the Eden repository (packages/client). See the repository's" +
      " README and docs/INTEGRATION.md.\n",
  );
  return out;
}

function declarationFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".d.ts"))
    .map((e) => join(e.parentPath, e.name));
}

if (import.meta.main) {
  const out = await packClient(process.argv[2] ?? join(packages, "..", "dist", "eden-client"));
  console.log(`@eden/client packed to ${out}`);
  console.log(`install it in your agent: npm install ${out}   (or: bun add ${out})`);
}
