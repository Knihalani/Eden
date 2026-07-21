"use client";

/**
 * Model Advisor — comparison + recommendation surface.
 * Views live in `_components/*` (Wave 9.8 / Wave 10 split ≤400).
 * Nested under Cost hub — identity lives on the Cost PageHeader only.
 */

import { useEffect, useState } from "react";
import {
  Gauge,
  Sparkles,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { PageContent } from "@/components/layout/page-content";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useOrg } from "@/hooks/use-org";
import {
  modelAdvisorApi,
  type ModelComparisonDto,
  type ModelRefDto,
  type RecommendationDto,
  type SwitchProjectionDto,
} from "@/lib/api";
import {
  CANDIDATES,
  DEFAULT_CANDIDATE_IDS,
  CandidatePicker,
  CompareView,
  ProjectView,
  RecommendationCard,
  optKey,
} from "./_components/advisor-views";


export default function ModelAdvisorPage() {
  const { currentOrg } = useOrg();

  const [mode, setMode] = useState<"pick" | "switch">("switch");
  const [currentKey, setCurrentKey] = useState<string>("openai::gpt-4o");
  const [candidateKeys, setCandidateKeys] = useState<string[]>(DEFAULT_CANDIDATE_IDS);
  const [windowDays, setWindowDays] = useState<number>(30);
  const [scaleFactor, setScaleFactor] = useState<number>(1);

  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [cmpLoading, setCmpLoading] = useState(false);
  const [cmpError, setCmpError] = useState<string | null>(null);
  const [projLoading, setProjLoading] = useState(false);
  const [projError, setProjError] = useState<string | null>(null);

  const [recommendation, setRecommendation] = useState<RecommendationDto | null>(null);
  const [comparison, setComparison] = useState<ModelComparisonDto | null>(null);
  const [projection, setProjection] = useState<SwitchProjectionDto | null>(null);

  useEffect(() => {
    if (!currentOrg) return;
    if (candidateKeys.length === 0) {
      setRecommendation(null);
      return;
    }
    let cancelled = false;
    setRecLoading(true);
    setRecError(null);

    const candidateRefs: ModelRefDto[] = candidateKeys.map((k) => {
      const [provider, ...rest] = k.split("::");
      return { provider, model_id: rest.join("::") };
    });
    const currentRef: ModelRefDto | null =
      mode === "switch" && currentKey
        ? (() => {
            const [provider, ...rest] = currentKey.split("::");
            return { provider, model_id: rest.join("::") };
          })()
        : null;

    modelAdvisorApi
      .recommend(currentOrg.id, {
        mode,
        candidates: candidateRefs,
        current: currentRef ?? undefined,
        window_days: windowDays,
      })
      .then((rec) => {
        if (cancelled) return;
        setRecommendation(rec);
      })
      .catch((e) => {
        if (cancelled) return;
        setRecError(e instanceof Error ? e.message : "Failed to load recommendation");
      })
      .finally(() => {
        if (!cancelled) setRecLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id, mode, currentKey, candidateKeys.join("|"), windowDays]);

  useEffect(() => {
    if (!currentOrg) return;
    if (mode !== "switch" || !currentKey) {
      setComparison(null);
      return;
    }
    const candidateKey = candidateKeys[0] ?? currentKey;
    if (candidateKey === currentKey) {
      setComparison(null);
      return;
    }
    let cancelled = false;
    setCmpLoading(true);
    setCmpError(null);

    const [curP, ...curRest] = currentKey.split("::");
    const [candP, ...candRest] = candidateKey.split("::");

    modelAdvisorApi
      .compare(currentOrg.id, {
        current: { provider: curP, model_id: curRest.join("::") },
        candidate: { provider: candP, model_id: candRest.join("::") },
      })
      .then((c) => {
        if (cancelled) return;
        setComparison(c);
      })
      .catch((e) => {
        if (cancelled) return;
        setCmpError(e instanceof Error ? e.message : "Failed to compare");
      })
      .finally(() => {
        if (!cancelled) setCmpLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id, mode, currentKey, candidateKeys.join("|")]);

  useEffect(() => {
    if (!currentOrg) return;
    if (mode !== "switch" || !currentKey) {
      setProjection(null);
      return;
    }
    const candidateKey = candidateKeys[0] ?? currentKey;
    if (candidateKey === currentKey) {
      setProjection(null);
      return;
    }
    let cancelled = false;
    setProjLoading(true);
    setProjError(null);

    const [curP, ...curRest] = currentKey.split("::");
    const [candP, ...candRest] = candidateKey.split("::");

    modelAdvisorApi
      .project(currentOrg.id, {
        current: { provider: curP, model_id: curRest.join("::") },
        candidate: { provider: candP, model_id: candRest.join("::") },
        scale_factor: scaleFactor,
        window_days: windowDays,
      })
      .then((p) => {
        if (cancelled) return;
        setProjection(p);
      })
      .catch((e) => {
        if (cancelled) return;
        setProjError(e instanceof Error ? e.message : "Failed to project");
      })
      .finally(() => {
        if (!cancelled) setProjLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id, mode, currentKey, candidateKeys.join("|"), scaleFactor, windowDays]);

  if (!currentOrg) {
    return <NoOrgState feature="Model advisor" />;
  }

  return (
    <div data-wave10-advisor="split" data-wave7-advisor="compare">
    <PageContent size="wide">
      <h2 className="sr-only">Model advisor</h2>
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-secondary)]">Mode</span>
              <div
                role="group"
                aria-label="Advisor mode"
                className="inline-flex rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] p-1"
              >
                <Button
                  type="button"
                  size="sm"
                  variant={mode === "switch" ? "default" : "ghost"}
                  onClick={() => setMode("switch")}
                  aria-pressed={mode === "switch"}
                >
                  Switch from current
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={mode === "pick" ? "default" : "ghost"}
                  onClick={() => setMode("pick")}
                  aria-pressed={mode === "pick"}
                >
                  Fresh pick
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-secondary)]">Window</span>
              <Select
                value={String(windowDays)}
                onValueChange={(v) => setWindowDays(parseInt(v, 10))}
              >
                <SelectTrigger className="h-8 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">7 days</SelectItem>
                  <SelectItem value="14">14 days</SelectItem>
                  <SelectItem value="30">30 days</SelectItem>
                  <SelectItem value="60">60 days</SelectItem>
                  <SelectItem value="90">90 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {mode === "switch" && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  Currently using
                </label>
                <Select value={currentKey} onValueChange={setCurrentKey}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CANDIDATES.map((o) => (
                      <SelectItem key={optKey(o)} value={optKey(o)}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  Candidates
                </label>
                <CandidatePicker selected={candidateKeys} onChange={setCandidateKeys} />
              </div>
            </div>
          )}

          {mode === "pick" && (
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Candidates
              </label>
              <CandidatePicker selected={candidateKeys} onChange={setCandidateKeys} />
            </div>
          )}
        </CardContent>
      </Card>

      {candidateKeys.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Pick at least one candidate"
          description="Add one or more models above and we will rank them by quality, cost, reliability, and latency."
        />
      ) : (
        <RecommendationCard rec={recommendation} loading={recLoading} error={recError} />
      )}

      {mode === "switch" && candidateKeys[0] && candidateKeys[0] !== currentKey && (
        <div
          className="grid grid-cols-1 gap-4 xl:grid-cols-2"
          data-testid="advisor-side-by-side"
        >
          <CompareView comparison={comparison} loading={cmpLoading} error={cmpError} />
          <ProjectView
            projection={projection}
            loading={projLoading}
            error={projError}
            scaleFactor={scaleFactor}
            onScale={setScaleFactor}
          />
        </div>
      )}

      <div className="rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-4 py-3 text-xs text-[var(--text-muted)]">
        <Gauge className="mr-1 inline h-3.5 w-3.5" />
        Scoring is{" "}
        <span className="font-medium text-[var(--text-primary)]">quality 60% · cost 25% · reliability 10% · latency 5%</span>
        {" "}— biased toward &quot;what would still work well&quot; rather than &quot;what&apos;s cheapest&quot;.         Prices honour your contract overrides.
      </div>
    </PageContent>
    </div>
  );
}
