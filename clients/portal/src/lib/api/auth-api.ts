/**
 * Thin auth/org bootstrap API — kept off ``resources.ts`` so the portal
 * shell (AuthProvider / OrgProvider / create-workspace) does not pull
 * the ~7k-line mega module into the shared client chunk.
 */
import { fetchApi } from "@/lib/api/core";

export type MeResponse = {
  user_id: string;
  email: string;
  name: string;
  organizations: Array<{
    id: string;
    name: string;
    slug: string;
    role: string;
    clerk_org_id?: string | null;
    is_personal?: boolean;
  }>;
  current_org_id: string | null;
};

export type CreateOrgResponse = {
  org_id: string;
  name: string;
  slug: string;
  role: string;
  clerk_org_id: string | null;
  org_degraded: boolean;
};

export const authApi = {
  getMe: () => fetchApi<MeResponse>("/auth/me"),

  createOrg: (name: string, makeDefault?: boolean) =>
    fetchApi<CreateOrgResponse>("/orgs", {
      method: "POST",
      body: JSON.stringify({ name, make_default: makeDefault ?? true }),
    }),
};

/** Compat shape for ``useMeQuery`` / callers that expect ``api.getMe``. */
export const api = {
  getMe: authApi.getMe,
  createOrg: authApi.createOrg,
};
