"use client";

import { Server } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";

/**
 * APM Depth page — formerly Cat 22 in-process tail-sampling,
 * K8s enrichment, and Pyroscope correlation UI.
 *
 * ponytail: per upgradespec §D.1 (Phase 1 cut), the bespoke
 * in-process stack was removed. Tail sampling is now handled
 * by the OTel Collector ``tail_sampling`` processor; K8s
 * enrichment by the OTel Collector ``k8sattributes`` processor
 * (or K8s Downward API env vars); continuous profiling by
 * Grafana Phlare. See ``deploy/otel-collector-config.yaml``
 * for the install config.
 *
 * The v1.4 surface (OtelV141Enricher, StepJudgeStamper,
 * AgentMetricsCollector) is still real — see the observability
 * trace detail page for per-step judge stamps.
 */

export default function ApmPage() {
  return (
    <div className="space-y-6 page-enter">
      <PageHeader
        icon={Server}
        title="APM Depth"
        subtitle="Migrated to the OTel Collector"
      />
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-elev-1)] p-6">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          Install the OTel Collector
        </h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Tail-based sampling, K8s attribute enrichment, and continuous
          profiling are now handled outside the Eden gateway by the
          OpenTelemetry Collector and Grafana Phlare. The in-process
          stack was removed per upgradespec §D.1.
        </p>
        <pre className="mt-4 overflow-x-auto rounded bg-[var(--bg-elev-2)] p-4 text-xs">
{`helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm install otel-collector open-telemetry/opentelemetry-collector \\
  -f deploy/otel-collector-config.yaml`}
        </pre>
        <p className="mt-4 text-sm text-[var(--text-secondary)]">
          See <code className="rounded bg-[var(--bg-elev-2)] px-1.5 py-0.5">deploy/otel-collector-config.yaml</code> for the
          full pipeline (tail_sampling → k8sattributes → batch → otlp/eden).
        </p>
      </div>
    </div>
  );
}