"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useOrg } from "@/hooks/use-org";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Cpu, Box, MessageSquare, FlaskConical, SplitSquareHorizontal, ShieldCheck, ActivitySquare, Database, AlertCircle, Loader2 } from "lucide-react";

// Heavy tabs — code-split via next/dynamic so the initial /llmops
// bundle doesn't ship all seven tabs' state/markup (~900 lines)
// regardless of which one (if any) the user opens. Mirrors the
// settings page's dynamic-tab pattern. (Phase 4 perf pass.)
const tabLoading = () => (
  <div className="flex items-center justify-center py-20">
    <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
  </div>
);
const ModelsTab = dynamic(() => import("./_components/tabs").then((m) => ({ default: m.ModelsTab })), {
  ssr: false,
  loading: tabLoading,
});
const PromptsTab = dynamic(() => import("./_components/tabs").then((m) => ({ default: m.PromptsTab })), {
  ssr: false,
  loading: tabLoading,
});
const ExperimentsTab = dynamic(() => import("./_components/tabs").then((m) => ({ default: m.ExperimentsTab })), {
  ssr: false,
  loading: tabLoading,
});
const ABTestsTab = dynamic(() => import("./_components/tabs").then((m) => ({ default: m.ABTestsTab })), {
  ssr: false,
  loading: tabLoading,
});
const GatewayTab = dynamic(() => import("./_components/tabs").then((m) => ({ default: m.GatewayTab })), {
  ssr: false,
  loading: tabLoading,
});
const MonitoringTab = dynamic(() => import("./_components/tabs").then((m) => ({ default: m.MonitoringTab })), {
  ssr: false,
  loading: tabLoading,
});
const CacheTab = dynamic(() => import("./_components/tabs").then((m) => ({ default: m.CacheTab })), {
  ssr: false,
  loading: tabLoading,
});

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────
interface TabConfig {
  key: string;
  label: string;
  icon: typeof Cpu;
}
const TABS: TabConfig[] = [{
  key: "models",
  label: "Models",
  icon: Box
}, {
  key: "prompts",
  label: "Prompts",
  icon: MessageSquare
}, {
  key: "experiments",
  label: "Experiments",
  icon: FlaskConical
}, {
  key: "abtests",
  label: "A/B Tests",
  icon: SplitSquareHorizontal
}, {
  key: "gateway",
  label: "Gateway",
  icon: ShieldCheck
}, {
  key: "monitoring",
  label: "Monitoring",
  icon: ActivitySquare
}, {
  key: "cache",
  label: "Cache",
  icon: Database
}];

// ──────────────────────────────────────────────────────────────────────────
// Main Page
// ──────────────────────────────────────────────────────────────────────────

export default function LLMOpsPage() {
  const {
    currentOrg
  } = useOrg();
  const [activeTab, setActiveTab] = useState("models");
  const [error, setError] = useState("");
  const orgId = currentOrg?.id;
  if (!currentOrg) {
    return <NoOrgState feature="LLMOps" />;
  }
  return <PageContent size="wide">
      <PageHeader title="LLMOps & Experiments" subtitle="Model registry, prompt management, experiment tracking, and production monitoring" icon={Cpu} eyebrow="Operate" />

      <Tabs
        value={activeTab}
        onValueChange={(tab) => {
          setActiveTab(tab);
          setError("");
        }}
        className="space-y-6"
      >
        <TabsList
          variant="underline"
          aria-label="LLMOps sections"
          className="border-b border-[var(--border-default)] w-full justify-start overflow-x-auto -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8"
        >
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <TabsTrigger key={tab.key} value={tab.key} variant="underline" className="flex items-center gap-2">
                <Icon className="w-4 h-4" aria-hidden="true" />
                {tab.label}
              </TabsTrigger>
            );
          })}
        </TabsList>

      {error && <div className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>}

      {!orgId ? null : (
        <>
          <TabsContent value="models"><ModelsTab orgId={orgId} /></TabsContent>
          <TabsContent value="prompts"><PromptsTab orgId={orgId} /></TabsContent>
          <TabsContent value="experiments"><ExperimentsTab orgId={orgId} /></TabsContent>
          <TabsContent value="abtests"><ABTestsTab orgId={orgId} /></TabsContent>
          <TabsContent value="gateway"><GatewayTab orgId={orgId} /></TabsContent>
          <TabsContent value="monitoring"><MonitoringTab orgId={orgId} /></TabsContent>
          <TabsContent value="cache"><CacheTab orgId={orgId} /></TabsContent>
        </>
      )}
      </Tabs>
    </PageContent>;
}
