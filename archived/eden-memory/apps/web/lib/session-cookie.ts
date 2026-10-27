/** Clerk sets `__client_uat` to `"0"` when there is no session. */
export function hasClerkSession(cookies: { get: (name: string) => { value: string } | undefined }): boolean {
  const uat = cookies.get("__client_uat")?.value;
  if (uat && uat !== "0") return true;
  return Boolean(cookies.get("__session")?.value);
}
