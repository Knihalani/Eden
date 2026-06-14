/**
 * tarballBuilder — package a :class:`SpecBundle` into a single
 * archive the backend can extract.
 *
 * The backend (``src/eden/api/routes/agent_runs.py`` —
 * ``_extract_archive``) accepts ``.tar.gz``, ``.tgz``, **or
 * ``.zip``**. The CLI's ``agent-push`` produces a ``.tar.gz``,
 * but ZIP is a single fflate call away and avoids hand-rolling
 * the TAR format (which needs checksum arithmetic, octal
 * encoding, and zero-padding for every file). The backend
 * detects ZIP from the filename *or* the leading ``PK`` magic
 * bytes, so the format is interchangeable on the wire.
 */

import { strToU8, zipSync } from "fflate";

import type { SpecBundle } from "./types";

/** Default level is 6 (the fflate default; same as gzip(1)). */
export const ZIP_LEVEL = 6;

export function buildTarball(bundle: SpecBundle): Uint8Array {
  const fileMap: Record<string, Uint8Array> = {
    "eden-sim-eval.yaml": strToU8(bundle.yaml),
    "agent.py": strToU8(""),
  };

  for (const f of bundle.files) {
    // Defensive: refuse to write paths that escape the root.
    if (f.path.includes("..") || f.path.startsWith("/")) {
      throw new Error(`Refusing to package unsafe path: ${f.path}`);
    }
    fileMap[f.path] = strToU8(f.body);
  }

  // The eden-sim-eval.yaml is the canonical first file the runner
  // looks for; the stub agent.py is the default module the driver
  // imports. The runner ignores any extra files. The README is
  // human-facing only.
  return zipSync(fileMap, { level: ZIP_LEVEL });
}

/** A safe slug derived from a user-typed graph name. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "agent"
  );
}

/** Convenience: a ``File`` ready for ``agentsApi.upload``. */
export function buildTarballFile(
  graphName: string,
  bundle: SpecBundle,
): File {
  const bytes = buildTarball(bundle);
  const filename = `${slugify(graphName)}.zip`;
  // fflate returns ``Uint8Array<ArrayBufferLike>``; the ``File``
  // constructor wants a ``BlobPart``. The blob constructor's
  // part list is more permissive than the type indicates — a
  // simple cast at the boundary is the standard pattern.
  const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
  return new File([blob], filename, { type: "application/zip" });
}
