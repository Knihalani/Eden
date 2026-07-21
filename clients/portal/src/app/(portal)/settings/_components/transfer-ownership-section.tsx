"use client";

import { useMemo, useState } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Organization } from "@/lib/types";
import { canTransferOwnership } from "@/lib/workspace-mode";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { TransferOwnershipDialog } from "./transfer-ownership-dialog";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { errorFromCaught } from "@/lib/safe-error-message";
import type { TransferMember } from "./org-tab-helpers";

interface TransferOwnershipSectionProps {
  org: Organization;
}

export function TransferOwnershipSection({ org }: TransferOwnershipSectionProps) {
  const [selectedMember, setSelectedMember] = useState<TransferMember | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const { refreshOrgs } = useOrg();

  // Soft-hide for personal/solo workspaces — nowhere to transfer to.
  if (!canTransferOwnership(org)) return null;

  return (
    <TransferOwnershipSectionInner
      org={org}
      isExpanded={isExpanded}
      setIsExpanded={setIsExpanded}
      selectedMember={selectedMember}
      setSelectedMember={setSelectedMember}
      refreshOrgs={refreshOrgs}
    />
  );
}

function TransferOwnershipSectionInner({
  org,
  isExpanded,
  setIsExpanded,
  selectedMember,
  setSelectedMember,
  refreshOrgs,
}: {
  org: Organization;
  isExpanded: boolean;
  setIsExpanded: (v: boolean | ((p: boolean) => boolean)) => void;
  selectedMember: TransferMember | null;
  setSelectedMember: (m: TransferMember | null) => void;
  refreshOrgs: () => Promise<void>;
}) {
  const membersQuery = useOrgQuery(
    queryKeys.settings.members(org.id),
    org.id,
    () => api.listOrgMembers(org.id) as Promise<TransferMember[]>,
    { enabled: isExpanded },
  );
  const members = useMemo(
    () => (membersQuery.data ?? []).filter((m) => m.role !== "owner"),
    [membersQuery.data],
  );
  const loadingMembers = membersQuery.isLoading;
  const membersError = membersQuery.error
    ? errorFromCaught(membersQuery.error, "Could not load members")
    : null;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="border-[var(--error)] text-[var(--error)] hover:bg-[var(--error-dim)]"
      >
        <RefreshCw className={cn("w-4 h-4", isExpanded && "animate-spin")} />
        Transfer ownership
      </Button>

      {isExpanded ? (
        <Card padding="md" className="w-full">
          {loadingMembers ? (
            <div className="flex items-center justify-center py-space-8">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
            </div>
          ) : membersError ? (
            <ErrorState
              title="Could not load members"
              message={membersError}
              size="sm"
              action={
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void membersQuery.refetch()}
                >
                  <RefreshCw className="h-4 w-4" />
                  Try again
                </Button>
              }
            />
          ) : members.length > 0 ? (
            <>
              <p className="text-sm text-[var(--text-secondary)] mb-space-3">
                Select a member to transfer ownership to. You will become an admin after the
                transfer.
              </p>
              <div className="space-y-space-2">
                {members.map((m) => (
                  <div
                    key={m.user_id}
                    className="flex items-center justify-between p-space-3 bg-[var(--bg-tertiary)] rounded-lg"
                  >
                    <div className="flex items-center gap-space-3">
                      <div className="w-8 h-8 bg-[var(--accent-faint)] rounded-full flex items-center justify-center">
                        <span className="text-[var(--accent)] font-medium text-sm">
                          {m.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div>
                        <p className="font-medium text-sm text-[var(--text-primary)]">{m.name}</p>
                        <p className="text-xs text-[var(--text-secondary)]">{m.email}</p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setSelectedMember(m)}
                    >
                      Transfer
                    </Button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">No other members to transfer to.</p>
          )}
        </Card>
      ) : null}

      {selectedMember ? (
        <TransferOwnershipDialog
          org={org}
          member={selectedMember}
          onClose={() => setSelectedMember(null)}
          onTransferred={async () => {
            await refreshOrgs();
          }}
        />
      ) : null}
    </>
  );
}
