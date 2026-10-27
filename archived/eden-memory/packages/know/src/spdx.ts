/** SPDX license list → `SPDX MIT is MIT License`. JSON catalog, no license text. */

import type { Triple } from "./extract";
import { SPDX_KEEP } from "./names";

export const SPDX_LICENSE_URL = "https://spdx.org/licenses/licenses.json";

type SpdxLicense = {
  licenseId?: string;
  name?: string;
  isDeprecatedLicenseId?: boolean;
};

type SpdxList = { licenses?: SpdxLicense[] };

export function parseSpdxLicenses(json: unknown): Triple[] {
  const licenses = (json as SpdxList)?.licenses;
  if (!Array.isArray(licenses)) return [];
  const out: Triple[] = [];
  const seen = new Set<string>();
  for (const row of licenses) {
    if (row.isDeprecatedLicenseId) continue;
    const id = (row.licenseId || "").trim();
    const name = (row.name || "").replace(/\s+/g, " ").trim();
    if (!id || !SPDX_KEEP.has(id) || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{1,80}$/.test(id) || seen.has(id)) continue;
    if (name.length < 3) continue;
    seen.add(id);
    out.push({ s: `SPDX ${id}`, p: "is", o: name.slice(0, 72), e: "" });
  }
  return out;
}
