"use client";

import { Suspense } from "react";
import { useOrg } from "@/hooks/use-org";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Shield, Plus, TestTube2, Loader2, ChevronDown, Swords } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQueryTab } from "@/hooks/use-query-tab";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GUARDRAILS_TABS, type GuardrailsTab } from "./_components/types";
import { GuardrailsKpi } from "./_components/guardrails-kpi";
import { TestTab } from "./_components/test-tab";
import { PoliciesTab } from "./_components/policies-tab";
import { AddPolicyDialog } from "./_components/add-policy-dialog";
import { InjectionsTab } from "./_components/injections-tab";
import { PiiTab } from "./_components/pii-tab";
import { RedteamReport } from "./_components/redteam-report";
import { useGuardrails } from "./_components/use-guardrails";

export default function GuardrailsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      }
    >
      <GuardrailsPageInner />
    </Suspense>
  );
}

function GuardrailsPageInner() {
  const { currentOrg } = useOrg();
  // Wave 6.1 — Policies primary; Red-team is report mode (not a peer first-paint tab).
  const [activeTab, setActiveTab] = useQueryTab("tab", GUARDRAILS_TABS, "policies");
  const g = useGuardrails(currentOrg?.id, activeTab);

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={Shield}
        feature="Guardrails"
        description="Org-critical content safety, prompt-injection defense, and PII redaction are configured per organization."
      />
    );
  }

  const enabledCount = g.policies.filter((p) => p.enabled).length;
  const statsPending = !g.policiesReady || g.policiesLoading;
  const tabsValue =
    activeTab === "injections" || activeTab === "pii" || activeTab === "redteam"
      ? activeTab
      : activeTab === "test"
        ? "test"
        : "policies";

  return (
    <PageContent size="wide">
      <div className="space-y-space-5" data-wave6-improve-guardrails="completed">
        <PageHeader
          title="Guardrails"
          subtitle="Content safety, injection defense, and PII redaction."
          actions={
            activeTab === "policies" ? (
              <Button
                className="min-h-11"
                onClick={() => g.setShowAddPolicy(true)}
                aria-label="Add new policy"
              >
                <Plus className="w-4 h-4" />
                Add policy
              </Button>
            ) : activeTab !== "test" ? (
              <Button
                className="min-h-11"
                variant="outline"
                onClick={() => setActiveTab("test")}
                aria-label="Open Test mode"
              >
                <TestTube2 className="w-4 h-4" />
                Test content
              </Button>
            ) : undefined
          }
        />

        <GuardrailsKpi
          policiesLength={g.policies.length}
          enabledCount={enabledCount}
          statsPending={statsPending}
        />

        <Tabs
          value={tabsValue}
          onValueChange={(v) => setActiveTab(v as GuardrailsTab)}
        >
          <div className="mb-space-4 flex flex-wrap items-end gap-space-2">
            <TabsList
              variant="underline"
              aria-label="Guardrails sections"
              className="h-auto flex-1 justify-start bg-transparent"
            >
              <TabsTrigger value="policies" variant="underline" className="min-h-11">
                Policies
              </TabsTrigger>
              <TabsTrigger
                value="test"
                variant="underline"
                className="min-h-11"
                data-testid="guardrails-test-mode-tab"
              >
                Test
              </TabsTrigger>
              {activeTab === "injections" ? (
                <TabsTrigger value="injections" variant="underline" className="min-h-11">
                  Injections
                </TabsTrigger>
              ) : null}
              {activeTab === "pii" ? (
                <TabsTrigger value="pii" variant="underline" className="min-h-11">
                  PII
                </TabsTrigger>
              ) : null}
              {activeTab === "redteam" ? (
                <TabsTrigger value="redteam" variant="underline" className="min-h-11" data-testid="guardrails-report-tab">
                  Report
                </TabsTrigger>
              ) : null}
            </TabsList>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="min-h-11"
                  aria-label="More guardrails surfaces"
                  data-testid="guardrails-more"
                >
                  More
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[12rem]">
                <DropdownMenuLabel>History & report</DropdownMenuLabel>
                <DropdownMenuItem
                  onSelect={() => setActiveTab("injections")}
                  data-testid="guardrails-more-injections"
                >
                  Injection history
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setActiveTab("pii")}
                  data-testid="guardrails-more-pii"
                >
                  PII log
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setActiveTab("redteam")}
                  data-testid="guardrails-more-redteam"
                >
                  <Swords className="mr-2 h-3.5 w-3.5" aria-hidden />
                  Red-team report
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div key={activeTab}>
            {activeTab === "test" ? (
              <TestTab
                testContent={g.testContent}
                onTestContentChange={g.setTestContent}
                evaluating={g.evaluating}
                scanning={g.scanning}
                redacting={g.redacting}
                onEvaluate={() => void g.handleEvaluate()}
                onScan={() => void g.handleInjectionScan()}
                onRedact={() => void g.handleRedact()}
                evaluateResult={g.evaluateResult}
                injectionResult={g.injectionResult}
                redactResult={g.redactResult}
                activeResultKind={g.activeResultKind}
                error={g.testError}
              />
            ) : null}
            {activeTab === "policies" ? (
              <PoliciesTab
                policies={g.policies}
                loading={g.policiesLoading}
                error={g.policiesError}
                onAddPolicy={() => g.setShowAddPolicy(true)}
                onRefresh={() => void g.loadPolicies()}
                orgId={currentOrg.id}
                onPolicyCreated={() => void g.loadPolicies()}
              />
            ) : null}
            {activeTab === "injections" ? (
              <InjectionsTab
                history={g.injectionHistory}
                unavailable={g.scanHistoryUnavailable}
                error={g.scanHistoryError}
                onRetry={() => void g.loadScanHistory()}
              />
            ) : null}
            {activeTab === "pii" ? (
              <PiiTab
                history={g.piiHistory}
                unavailable={g.scanHistoryUnavailable}
                error={g.scanHistoryError}
                onRetry={() => void g.loadScanHistory()}
              />
            ) : null}
            {activeTab === "redteam" ? <RedteamReport /> : null}
          </div>
        </Tabs>

        <AddPolicyDialog
          open={g.showAddPolicy}
          onOpenChange={g.setShowAddPolicy}
          orgId={currentOrg.id}
          onCreated={() => {
            g.setShowAddPolicy(false);
            void g.loadPolicies();
          }}
        />
      </div>
    </PageContent>
  );
}
