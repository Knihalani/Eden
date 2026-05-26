"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { api } from "@/lib/api";
import type { Organization } from "@/lib/types";
import { useAuth } from "@/hooks/use-auth";

interface OrgContextType {
  currentOrg: Organization | null;
  organizations: Organization[];
  setCurrentOrg: (org: Organization | null) => void;
  refreshOrgs: () => Promise<void>;
  loading: boolean;
}

const OrgContext = createContext<OrgContextType | null>(null);

export function OrgProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [currentOrg, setCurrentOrgState] = useState<Organization | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(false);

  const refreshOrgs = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const orgs = await api.listOrgs();
      setOrganizations(orgs);

      // Set current org from user's preferred_org_id or first org (only non-archived)
      if (user.current_org_id) {
        const preferred = orgs.find((o) => o.id === user.current_org_id);
        if (preferred) setCurrentOrgState(preferred);
        else if (orgs.length > 0) {
          setCurrentOrgState(orgs[0]);
        } else {
          setCurrentOrgState(null);
        }
      } else if (orgs.length > 0) {
        setCurrentOrgState(orgs[0]);
      } else {
        setCurrentOrgState(null);
      }
    } catch (e) {
      console.error("Failed to load orgs:", e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      refreshOrgs();
    }
  }, [user, refreshOrgs]);

  const setCurrentOrg = useCallback((org: Organization | null) => {
    setCurrentOrgState(org);
  }, []);

  return (
    <OrgContext.Provider
      value={{ currentOrg, organizations, setCurrentOrg, refreshOrgs, loading }}
    >
      {children}
    </OrgContext.Provider>
  );
}

export function useOrg() {
  const context = useContext(OrgContext);
  if (!context) {
    throw new Error("useOrg must be used within OrgProvider");
  }
  return context;
}