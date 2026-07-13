"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, BookOpen, Loader2, RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { useOrg } from "@/hooks/use-org";
import { learnApi } from "@/lib/api";
import { errorFromCaught } from "@/lib/safe-error-message";

export default function AgentBookPage() {
  const params = useParams<{ id: string }>();
  const agentId = useMemo(
    () => (params?.id ? decodeURIComponent(params.id) : ""),
    [params?.id],
  );
  const { currentOrg } = useOrg();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!currentOrg || !agentId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await learnApi.getBook(currentOrg.id, agentId);
      const book = res.data?.book;
      const config = res.data?.config;
      setContent((book?.content_md as string) ?? null);
      setVersion((book?.version as number) ?? null);
      setEnabled(Boolean(config?.enabled));
    } catch (e) {
      setError(errorFromCaught(e, "Failed to load agent book"));
    } finally {
      setLoading(false);
    }
  }, [currentOrg, agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const regenerate = async () => {
    if (!currentOrg || !agentId) return;
    setBusy(true);
    try {
      await learnApi.regenerateBook(currentOrg.id, agentId);
      await load();
    } catch (e) {
      setError(errorFromCaught(e, "Regenerate failed"));
    } finally {
      setBusy(false);
    }
  };

  const toggleInjection = async () => {
    if (!currentOrg || !agentId) return;
    setBusy(true);
    try {
      await learnApi.patchBookConfig(currentOrg.id, agentId, {
        enabled: !enabled,
      });
      setEnabled(!enabled);
    } catch (e) {
      setError(errorFromCaught(e, "Config update failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContent>
      <PageHeader
        title="Agent Book"
        description={`Distilled learnings for ${agentId}`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button size="sm" onClick={() => void regenerate()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Regenerate"}
            </Button>
          </div>
        }
      />
      <Link
        href={`/agents/${encodeURIComponent(agentId)}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to agent
      </Link>

      {error ? (
        <ErrorState
          message={error}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      ) : null}

      <Card className="mb-4 flex items-center justify-between p-4">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-[var(--accent)]" />
          <span className="text-sm">
            Gateway injection {enabled ? "enabled" : "disabled"}
            {version != null ? ` · v${version}` : ""}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={() => void toggleInjection()} disabled={busy}>
          {enabled ? "Disable" : "Enable"}
        </Button>
      </Card>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--text-muted)]" />
        </div>
      ) : content ? (
        <Card className="prose prose-invert max-w-none p-6">
          <pre className="whitespace-pre-wrap font-sans text-sm">{content}</pre>
        </Card>
      ) : (
        <EmptyState
          title="No book yet"
          description="Regenerate to synthesize chapters from resolved issues and promoted nudges."
          action={
            <Button size="sm" onClick={() => void regenerate()} disabled={busy}>
              Generate book
            </Button>
          }
        />
      )}
    </PageContent>
  );
}
