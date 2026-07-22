"use client";

import { useMemo, useState } from "react";
import {
  metricStudioApi,
  type MetricStudioExample,
  type MetricStudioMetric,
  type MetricStudioTemplate,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/components/ui/toast";

export type StudioSubTab = "templates" | "examples" | "metrics";

export type StudioExampleRow = MetricStudioExample & { rationale?: string };

export type TemplateSeed = {
  name: string;
  domain: string;
  notes?: string;
};

function blankExamples(): StudioExampleRow[] {
  return [
    { input: "", output: "", label: "pass", rationale: "" },
    { input: "", output: "", label: "fail", rationale: "" },
  ];
}

export function useStudioTab() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { user } = useAuth();
  const toast = useToast();

  const [subTab, setSubTab] = useState<StudioSubTab>("templates");
  const [templateSeed, setTemplateSeed] = useState<TemplateSeed | null>(null);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("general");
  const [examples, setExamples] = useState<StudioExampleRow[]>(blankExamples);
  const [generated, setGenerated] = useState<{
    rubric_id: string;
    rubric_prompt: string;
    rubric_tokens: number;
    domain: string;
  } | null>(null);

  const templatesQuery = useOrgQuery(
    queryKeys.metricStudio.templates(orgId),
    orgId,
    async () => {
      const data = await metricStudioApi.listTemplates(orgId!);
      return data.templates ?? [];
    },
  );

  const metricsQuery = useOrgQuery(
    queryKeys.metricStudio.metrics(orgId),
    orgId,
    async () => {
      const data = await metricStudioApi.listMetrics(orgId!);
      return data.metrics ?? [];
    },
  );

  const fromExamplesMutation = useOrgMutation(
    (vars: {
      name: string;
      domain?: string;
      examples: MetricStudioExample[];
    }) => metricStudioApi.fromExamples(orgId!, vars),
    {
      onSuccess: (data) => {
        setGenerated({
          rubric_id: data.rubric_id,
          rubric_prompt: data.rubric_prompt,
          rubric_tokens: data.rubric_tokens,
          domain: data.domain,
        });
        toast.success("Rubric generated");
      },
      onError: (e) => toast.error(e.message || "Rubric synthesis failed"),
    },
  );

  const createMetricMutation = useOrgMutation(
    (vars: {
      name: string;
      rubric_id: string;
      version?: string;
      status?: string;
      domain?: string;
    }) => metricStudioApi.createMetric(orgId!, vars),
    {
      invalidateKeys: [queryKeys.metricStudio.metrics(orgId)],
      onSuccess: () => {
        toast.success("Metric saved");
        setGenerated(null);
        setName("");
        setExamples(blankExamples());
        setSubTab("metrics");
      },
      onError: (e) => toast.error(e.message || "Metric registration failed"),
    },
  );

  const approveMutation = useOrgMutation(
    (vars: { metricId: string; approved_by: string }) =>
      metricStudioApi.approveMetric(orgId!, vars.metricId, {
        approved_by: vars.approved_by,
      }),
    {
      invalidateKeys: [queryKeys.metricStudio.metrics(orgId)],
      onSuccess: () => toast.success("Metric approved"),
      onError: (e) => toast.error(e.message || "Approval failed"),
    },
  );

  const templates: MetricStudioTemplate[] = templatesQuery.data ?? [];
  const metrics: MetricStudioMetric[] = metricsQuery.data ?? [];

  const dirty = useMemo(() => {
    if (generated) return true;
    if (name.trim()) return true;
    return examples.some(
      (e) => e.input.trim() || e.output.trim() || (e.rationale ?? "").trim(),
    );
  }, [examples, generated, name]);

  function useTemplate(seed: TemplateSeed) {
    setTemplateSeed(seed);
    setName(seed.name);
    setDomain(seed.domain || "general");
    if (seed.notes) {
      setExamples((prev) =>
        prev.map((row, idx) =>
          idx === 0
            ? { ...row, rationale: seed.notes || row.rationale }
            : row,
        ),
      );
    }
    setSubTab("examples");
  }

  function generateFromExamples() {
    const filled = examples.filter((e) => e.input.trim() && e.output.trim());
    if (filled.length < 2) {
      toast.error("Provide at least 2 examples with input and output.");
      return;
    }
    if (!name.trim()) {
      toast.error("Name is required.");
      return;
    }
    fromExamplesMutation.mutate({
      name: name.trim(),
      domain: domain.trim() || "general",
      examples: filled.map((e) => ({
        input: e.input.trim(),
        output: e.output.trim(),
        label: e.label,
        rationale: e.rationale?.trim() || undefined,
      })),
    });
  }

  function saveGeneratedMetric() {
    if (!generated) return;
    createMetricMutation.mutate({
      name: name.trim() || generated.rubric_id,
      rubric_id: generated.rubric_id,
      domain: generated.domain || domain.trim() || "general",
    });
  }

  function approveMetric(metric: MetricStudioMetric) {
    const approvedBy = user?.email?.trim() || user?.user_id;
    if (!approvedBy) {
      toast.error("Signed-in user is required to approve.");
      return;
    }
    approveMutation.mutate({
      metricId: metric.metric_id,
      approved_by: approvedBy,
    });
  }

  function requestSubTab(next: StudioSubTab) {
    if (next === subTab) return;
    if (subTab === "examples" && dirty) {
      const leave = window.confirm(
        "You have unsaved rubric work. Leave this tab?",
      );
      if (!leave) return;
    }
    setSubTab(next);
  }

  return {
    orgId,
    subTab,
    requestSubTab,
    templates,
    templatesQuery,
    metrics,
    metricsQuery,
    name,
    setName,
    domain,
    setDomain,
    examples,
    setExamples,
    generated,
    setGenerated,
    templateSeed,
    setTemplateSeed,
    useTemplate,
    generateFromExamples,
    saveGeneratedMetric,
    approveMetric,
    fromExamplesMutation,
    createMetricMutation,
    approveMutation,
    dirty,
  };
}
