"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FIRST_EVENT_WAIT } from "@/lib/portal-polish";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";
import { ConnectGatewayPanel } from "../_components/connect-gateway-panel";
import { ConnectSdkPanel } from "../_components/connect-sdk-panel";

type Checklist = {
  keyCreated: boolean;
  requestSent: boolean;
  waiting: boolean;
};

export default function AgentsConnectPage() {
  const t = useTranslations("agents.connect");
  const tAgents = useTranslations("agents");
  const router = useRouter();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { hasPermission, role } = usePermissions();
  const canConnect =
    hasPermission("jobs:write") ||
    (role != null && role !== "viewer");

  const [path, setPath] = useState<"gateway" | "sdk">("gateway");
  const [checklist, setChecklist] = useState<Checklist>({
    keyCreated: false,
    requestSent: false,
    waiting: false,
  });
  const [pollError, setPollError] = useState<string | null>(null);

  const pollFirstTrace = useCallback(async () => {
    if (!orgId) return;
    setChecklist((c) => ({ ...c, requestSent: true, waiting: true }));
    setPollError(null);
    try {
      const res = await api.listObservabilityTraces(orgId, {
        days: 7,
        limit: 5,
      });
      const traces = res.traces ?? [];
      if (traces.length > 0) {
        const agentId = traces[0]?.agent_id;
        if (agentId) {
          router.push(`/agents/${encodeURIComponent(agentId)}`);
        } else {
          router.push("/dashboard");
        }
        return;
      }
      setPollError(t("stillWaiting"));
    } catch (e) {
      setPollError(e instanceof Error ? e.message : t("pollError"));
    } finally {
      setChecklist((c) => ({ ...c, waiting: false }));
    }
  }, [orgId, router, t]);

  useEffect(() => {
    if (!checklist.requestSent || !orgId) return;
    const id = window.setInterval(() => {
      void pollFirstTrace();
    }, FIRST_EVENT_WAIT.pollMs);
    return () => window.clearInterval(id);
  }, [checklist.requestSent, orgId, pollFirstTrace]);

  return (
    <div className="mx-auto max-w-3xl space-y-6" data-testid="agents-connect">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/agents">{tAgents("backToList")}</Link>
          </Button>
        }
      />

      <nav aria-label="Breadcrumb" className="text-sm text-[var(--text-muted)]">
        <Link href="/agents" className="hover:text-[var(--text-primary)]">
          {tAgents("title")}
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-[var(--text-secondary)]">{t("crumb")}</span>
      </nav>

      <Tabs
        value={path}
        onValueChange={(v) => setPath(v as "gateway" | "sdk")}
        data-testid="connect-path-tabs"
      >
        <TabsList variant="pills">
          <TabsTrigger variant="pills" value="gateway">
            {t("gateway")}
          </TabsTrigger>
          <TabsTrigger variant="pills" value="sdk">
            {t("sdk")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="gateway" className="mt-4">
          <ConnectGatewayPanel
            canConnect={canConnect}
            onKeyCreated={() =>
              setChecklist((c) => ({ ...c, keyCreated: true }))
            }
          />
        </TabsContent>
        <TabsContent value="sdk" className="mt-4">
          <ConnectSdkPanel
            canConnect={canConnect}
            onKeyCreated={() =>
              setChecklist((c) => ({ ...c, keyCreated: true }))
            }
          />
        </TabsContent>
      </Tabs>

      <Panel tone="flat" padding="md" className="space-y-3">
        <h2 className="text-sm font-medium text-[var(--text-primary)]">
          {t("checklistTitle")}
        </h2>
        <ol className="list-decimal space-y-1.5 pl-4 text-sm text-[var(--text-secondary)]">
          <li data-done={checklist.keyCreated ? "true" : "false"}>
            {t("checkKey")}
            {checklist.keyCreated ? ` — ${t("done")}` : ""}
          </li>
          <li data-done={checklist.requestSent ? "true" : "false"}>
            {t("checkRequest")}
          </li>
          <li>{t("checkTrace")}</li>
        </ol>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            disabled={!orgId || checklist.waiting}
            onClick={() => void pollFirstTrace()}
            className="min-h-11"
          >
            {checklist.waiting ? t("polling") : t("sentRequest")}
          </Button>
          <Button asChild variant="ghost" size="sm">
            <a
              href={DOCS_QUICKSTART_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("docs")}
            </a>
          </Button>
        </div>
        {pollError ? (
          <p className="text-sm text-[var(--text-muted)]" role="status">
            {pollError}
          </p>
        ) : null}
      </Panel>

      <Panel
        tone="subtle"
        padding="md"
        className="space-y-2"
        data-testid="connect-troubleshoot"
      >
        <h2 className="text-sm font-medium text-[var(--text-primary)]">
          {t("troubleshootTitle")}
        </h2>
        <ul className="list-disc space-y-1 pl-4 text-sm text-[var(--text-secondary)]">
          <li>{t("troubleAuth")}</li>
          <li>{t("troubleModel")}</li>
          <li>{t("troubleCors")}</li>
        </ul>
      </Panel>
    </div>
  );
}
