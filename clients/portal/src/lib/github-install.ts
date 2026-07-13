/** GitHub App install callback helpers for the onboarding wizard. */

export const GITHUB_INSTALL_STORAGE_KEY = "eden:onboarding:github_installation_id";

/** Parse GitHub's installation_id query param (digits only). */
export function parseInstallationId(
  raw: string | null | undefined,
): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function readStoredInstallationId(): number | null {
  if (typeof window === "undefined") return null;
  return parseInstallationId(sessionStorage.getItem(GITHUB_INSTALL_STORAGE_KEY));
}

export function storeInstallationId(id: number): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(GITHUB_INSTALL_STORAGE_KEY, String(id));
}

export function clearStoredInstallationId(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(GITHUB_INSTALL_STORAGE_KEY);
}
