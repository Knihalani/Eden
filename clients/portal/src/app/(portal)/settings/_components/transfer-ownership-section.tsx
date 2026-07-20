"use client";

import { useState } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Organization } from "@/lib/types";
import { TransferOwnershipDialog } from "./transfer-ownership-dialog";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { errorFromCaught } from "@/lib/safe-error-message";

interface Member {
  user_id: string;
  name: string;
  email: string;
  role: string;
}

interface TransferOwnershipSectionProps {
  org: Organization;
}

export function TransferOwnershipSection({
  org,
}: TransferOwnershipSectionProps) {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const { refreshOrgs } = useOrg();

  // Soft-hide for personal/solo workspaces — nowhere to transfer to.
  if (org.is_personal) return null;

  const loadMembers = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.listOrgMembers(org.id);
      setMembers(data.filter((m) => m.role !== "owner"));
    } catch (e) {
      // Fail closed: do not claim "No other members" on a load outage.
      setLoadError(errorFromCaught(e, "Failed to load members"));
      setMembers([]);
    } finally {
      setLoading(false);
    }
  };

  const toggleExpanded = async () => {
    if (isExpanded) {
      setIsExpanded(false);
    } else {
      setIsExpanded(true);
      if (members.length === 0 || loadError) {
        await loadMembers();
      }
    }
  };

  const handleTransferred = async () => {
    await refreshOrgs();
  };

  return (
    <>
      <button
        onClick={toggleExpanded}
        className="px-3 py-1.5 text-sm border border-[var(--border-default)] rounded-lg hover:bg-[var(--bg-tertiary)] inline-flex items-center gap-1.5 text-[var(--text-primary)]"
      >
        <RefreshCw className={cn("w-4 h-4", isExpanded && "animate-spin")} />
        Transfer Ownership
      </button>

      {isExpanded && (
        <Card padding="md" className="w-full mt-2">
          <h3 className="text-sm font-semibold mb-3 text-[var(--text-primary)]">
            Transfer Ownership
          </h3>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
            </div>
          ) : loadError ? (
            <ErrorState
              title="Could not load members"
              message={loadError}
              action={
                <Button variant="outline" size="sm" onClick={() => void loadMembers()}>
                  Try again
                </Button>
              }
            />
          ) : members.length > 0 ? (
            <>
              <p className="text-sm text-[var(--text-secondary)] mb-3">
                Select a member to transfer ownership to. You will become an admin after the
                transfer.
              </p>
              <div className="space-y-2">
                {members.map((member) => (
                  <div
                    key={member.user_id}
                    className="flex items-center justify-between p-3 bg-[var(--bg-tertiary)] rounded-lg"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-[var(--accent-bg)] rounded-full flex items-center justify-center">
                        <span className="text-[var(--accent)] font-medium text-sm">
                          {member.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div>
                        <p className="font-medium text-sm text-[var(--text-primary)]">
                          {member.name}
                        </p>
                        <p className="text-xs text-[var(--text-secondary)]">{member.email}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => setSelectedMember(member)}
                      className="px-3 py-1.5 text-sm bg-[var(--warning-bg)] text-[var(--warning)] rounded-lg hover:bg-[var(--warning-bg)]/80"
                    >
                      Transfer
                    </button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">No other members to transfer to.</p>
          )}
        </Card>
      )}

      {selectedMember && (
        <TransferOwnershipDialog
          org={org}
          member={selectedMember}
          onClose={() => setSelectedMember(null)}
          onTransferred={handleTransferred}
        />
      )}
    </>
  );
}
