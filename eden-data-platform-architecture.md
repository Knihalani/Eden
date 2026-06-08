# Eden — Data Platform & Lakehouse Architecture

> **Date:** May 29, 2026  
> **Purpose:** Define how Eden stores, processes, and governs the massive volume of agent traces, environment data, telemetry, and training datasets required to operate the platform and feed the continuous improvement flywheel.

---

## Table of Contents

1. [Strategic Thesis](#1-strategic-thesis)
2. [Lakehouse Architecture](#2-lakehouse-architecture)
3. [Storage Tiers](#3-storage-tiers)
4. [ETL/ELT Pipelines](#4-etlelt-pipelines)
5. [Data Quality Framework](#5-data-quality-framework)
6. [Time-Series & Event Storage](#6-time-series--event-storage)
7. [Data Retention & Archival](#7-data-retention--archival)
8. [GDPR & Compliance](#8-gdpr--compliance)
9. [Data Lineage](#9-data-lineage)
10. [Implementation Roadmap](#10-implementation-roadmap)

---

## 1. Strategic Thesis

Eden generates and consumes enormous volumes of data:
- **Agent traces:** Every step, thought, tool call, and observation from agents running in environments
- **Environment artifacts:** Generated code, configurations, test results
- **Telemetry:** Pipeline metrics, latency measurements, token usage, cost data
- **User feedback:** Acceptances, modifications, rejections, ratings
- **Training data:** Curated datasets for model fine-tuning and prompt optimization

This data is not exhaust — it is the primary asset that makes Eden better over time. The data platform must:
1. **Ingest at scale:** Handle millions of events per minute
2. **Store cost-effectively:** Tiered storage from hot SSD to cold archive
3. **Process reliably:** ETL pipelines with exactly-once semantics
4. **Govern strictly:** GDPR, CCPA, SOC-2 compliance by design
5. **Enable discovery:** Data lineage, cataloging, and quality visibility
6. **Feed the flywheel:** Transform raw data into structured datasets that improve environments

---

## 2. Lakehouse Architecture

### 2.1 Why Lakehouse?
Traditional data warehouses are too rigid for Eden's semi-structured agent traces. Data lakes lack ACID guarantees and efficient updates. The lakehouse pattern (open table formats on object storage) gives us:
- **Schema evolution:** Agent traces change as the platform evolves
- **Time travel:** Debug historical pipeline runs by querying data as-of a specific time
- **Concurrent reads/writes:** Multiple pipeline nodes write to the same tables
- **Transactionality:** Exactly-once ingestion from Kafka
- **Interoperability:** Query from Python (Pandas), SQL (Trino), and ML frameworks (PyTorch)

### 2.2 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         DATA SOURCES                                │
│  Agent Traces • Pipeline Logs • User Feedback • Benchmark Results │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     STREAM INGESTION (Kafka)                        │
│  • Raw events partitioned by tenant + event type                    │
│  • Schema validation via Avro schemas                               │
│  • At-least-once delivery, idempotent consumers                   │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                             ▼
┌──────────────────────────┐      ┌──────────────────────────┐
│    BRONZE (Raw)          │      │    OPERATIONAL DBs       │
│    Iceberg Tables        │      │                          │
│  • Unchanged raw events  │      │  • PostgreSQL (metadata) │
│  • JSON/Parquet format   │      │  • ClickHouse (metrics)  │
│  • Infinite retention    │      │  • Redis (hot cache)     │
└──────────┬───────────────┘      └──────────────────────────┘
           │
           ▼
┌──────────────────────────┐
│    SILVER (Cleaned)      │
│    dbt Transformations   │
│  • Deduplication         │
│  • PII scrubbing         │
│  • Schema normalization  │
│  • Quality scoring       │
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│    GOLD (Curated)        │
│    dbt Transformations   │
│  • Training datasets     │
│  • Benchmark suites      │
│  • Evaluation datasets   │
│  • Aggregated metrics    │
└──────────┬───────────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
┌──────────┐ ┌──────────┐
│ TRAINING │ │ ANALYTICS│
│ PIPELINES│ │ & REPORTS│
└──────────┘ └──────────┘
```

### 2.3 Table Format Selection

| Format | Use Case | Why |
|--------|----------|-----|
| **Apache Iceberg** | Primary lakehouse format | Best partition evolution, multi-engine support, active community |
| **Delta Lake** | Databricks integration (if used) | Deep Spark integration, robust time travel |
| **Apache Hudi** | Real-time agent trace updates | Best for high-frequency upserts on mutable traces |

Eden standardizes on **Apache Iceberg** for the lakehouse layer (federated query, schema evolution) and **Apache Hudi** for the high-frequency agent trace mutation stream (record-level updates to trace status).

---

## 3. Storage Tiers

### 3.1 Three-Tier Storage Model

```
┌─────────────────────────────────────────────────────────────┐
│                        HOT TIER                              │
│  NVMe SSD / Local Storage                                    │
│  • Last 7 days of traces                                     │
│  • Active job data                                          │
│  • Redis cache (embeddings, session state)                  │
│  Cost: $$$  |  Access: <10ms                                │
├─────────────────────────────────────────────────────────────┤
│                       WARM TIER                              │
│  S3 Standard / GCS Standard                                  │
│  • Last 90 days of Parquet/Iceberg files                    │
│  • Queryable via Trino / DuckDB                             │
│  • ClickHouse for aggregations                              │
│  Cost: $$   |  Access: <500ms                               │
├─────────────────────────────────────────────────────────────┤
│                       COLD TIER                              │
│  S3 Glacier / GCS Archive                                  │
│  • Historical snapshots (>90 days)                          │
│  • PII-scrubbed, compressed, encrypted                      │
│  • Audit/compliance only                                    │
│  Cost: $    |  Access: minutes-hours                        │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Automated Tiering Policy

```python
# S3 Lifecycle Policy (JSON)
{
  "Rules": [
    {
      "ID": "hot-to-warm",
      "Status": "Enabled",
      "Filter": { "Prefix": "traces/" },
      "Transitions": [
        { "Days": 7, "StorageClass": "STANDARD_IA" },
        { "Days": 30, "StorageClass": "GLACIER_IR" }
      ],
      "Expiration": { "Days": 2555 }  # 7 years for compliance
    },
    {
      "ID": "derived-datasets",
      "Status": "Enabled",
      "Filter": { "Prefix": "datasets/" },
      "Transitions": [
        { "Days": 90, "StorageClass": "GLACIER" }
      ]
    }
  ]
}
```

### 3.3 Compression & Encoding
- **Parquet files:** ZSTD compression, dictionary encoding for repeated strings (tenant IDs, event types)
- **JSON traces:** Stored as Parquet after Bronze→Silver transformation (10-20x size reduction)
- **Column pruning:** Remove unused columns from archived snapshots to save space

---

## 4. ETL/ELT Pipelines

### 4.1 Bronze Layer: Raw Ingestion

**Input:** Kafka topics (one per event type)
**Output:** Iceberg tables (partitioned by `date` + `tenant_id`)
**Format:** Original JSON preserved exactly — "load first, ask questions later"

```sql
-- Bronze table schema (Iceberg)
CREATE TABLE bronze.agent_traces (
    trace_id STRING,
    tenant_id STRING,
    job_id STRING,
    event_type STRING,
    payload STRING,           -- Original JSON as string
    ingested_at TIMESTAMP,
    kafka_offset BIGINT,
    kafka_partition INT
)
PARTITIONED BY (days(ingested_at), tenant_id);
```

### 4.2 Silver Layer: Cleaning & Normalization

**Tool:** dbt (data build tool) with SQL transformations
**Process:**
1. **Deduplication:** Remove exact duplicates (same kafka_offset)
2. **Schema validation:** Reject malformed events to quarantine table
3. **PII scrubbing:** Apply regex + NER-based redaction
4. **Enrichment:** Add derived fields (trace duration, token count, cost)
5. **Normalization:** Flatten nested JSON into queryable columns

```sql
-- dbt model: silver_agent_traces.sql
{{ config(
    materialized='incremental',
    partition_by=['date_day'],
    unique_key='trace_id'
) }}

WITH deduped AS (
    SELECT DISTINCT ON (trace_id) *
    FROM {{ ref('bronze_agent_traces') }}
    WHERE ingested_at > '{{ var("execution_date") }}'
    ORDER BY trace_id, kafka_offset DESC
),

enriched AS (
    SELECT
        trace_id,
        tenant_id,
        job_id,
        event_type,
        
        -- Extract from JSON payload
        payload->>'agent_name' as agent_name,
        payload->>'stage' as pipeline_stage,
        (payload->>'duration_ms')::INT as duration_ms,
        (payload->>'input_tokens')::INT as input_tokens,
        (payload->>'output_tokens')::INT as output_tokens,
        
        -- Derived metrics
        (payload->>'input_tokens')::INT + (payload->>'output_tokens')::INT as total_tokens,
        ((payload->>'input_tokens')::INT * 0.000003 + 
         (payload->>'output_tokens')::INT * 0.000015) as estimated_cost_usd,
        
        -- PII scrubbed payload
        {{ pii_scrub('payload') }} as scrubbed_payload,
        
        ingested_at,
        DATE(ingested_at) as date_day
    FROM deduped
)

SELECT * FROM enriched
```

### 4.3 Gold Layer: Curated Datasets

**Tool:** dbt + Python models for ML-specific transformations
**Output:** Training-ready datasets, benchmark suites, aggregated metrics

```sql
-- Gold: curated training dataset
create table gold.training_dataset as
select
    t.trace_id,
    t.tenant_id,
    j.environment_request as input,
    j.generated_code as output,
    t.quality_score,
    t.complexity_tier,
    t.framework,
    t.environment_class
from silver.enriched_traces t
join silver.jobs j on t.job_id = j.job_id
where t.quality_score > 0.7
  and t.outcome = 'success'
  and t.pii_detected = false;
```

### 4.4 Pipeline Orchestration

```
Kafka → Spark Streaming (Bronze) → dbt (Silver/Gold) → ML Training
                    │
                    └──→ Great Expectations (quality checks)
                    │
                    └──→ DataHub (lineage tracking)
```

- **Apache Airflow / Dagster** for pipeline scheduling and dependency management
- **Great Expectations** for data validation at every stage
- **DataHub** for automatic lineage extraction from dbt + Airflow

---

## 5. Data Quality Framework

### 5.1 Great Expectations Integration

Define expectations for every table:

```python
# expectations/silver_agent_traces.json
{
  "expectations": [
    {
      "expectation_type": "expect_column_values_to_not_be_null",
      "kwargs": {"column": "trace_id"}
    },
    {
      "expectation_type": "expect_column_values_to_be_unique",
      "kwargs": {"column": "trace_id"}
    },
    {
      "expectation_type": "expect_column_values_to_be_between",
      "kwargs": {
        "column": "duration_ms",
        "min_value": 0,
        "max_value": 300000  # 5 minutes max
      }
    },
    {
      "expectation_type": "expect_column_values_to_be_between",
      "kwargs": {
        "column": "total_tokens",
        "min_value": 0,
        "max_value": 1000000  # 1M token sanity check
      }
    },
    {
      "expectation_type": "expect_column_values_to_match_regex",
      "kwargs": {
        "column": "tenant_id",
        "regex": "^org_[a-z0-9]{12}$"
      }
    }
  ]
}
```

### 5.2 Soda Core for Anomaly Detection

```yaml
# checks/silver_agent_traces.yml
checks for silver_agent_traces:
  # Row count should not drop by >20% day-over-day
  - row_count > 0.8 * avg(row_count) within 7 days
  
  # Cost should not spike >3x normal
  - estimated_cost_usd < 3 * avg(estimated_cost_usd) within 7 days
  
  # Error rate should be <5%
  - failed_row_count / row_count < 0.05:
      filter: event_type = 'error'
  
  # PII detection rate should be <1%
  - pii_detected_count / row_count < 0.01
```

### 5.3 Data Contracts
Upstream services define contracts that downstream pipelines validate:

```python
# eden/contracts/agent_trace.py
from dataclasses import dataclass
from typing import Literal

@dataclass
class AgentTraceContract:
    """Contract for agent trace events. Breakage triggers alerts."""
    
    required_fields: list[str] = [
        "trace_id", "tenant_id", "job_id", 
        "event_type", "timestamp", "payload"
    ]
    
    field_types: dict[str, type] = {
        "trace_id": str,
        "tenant_id": str,
        "duration_ms": int,
        "input_tokens": int,
        "output_tokens": int
    }
    
    valid_event_types: list[str] = [
        "agent.start", "agent.think", "agent.act", 
        "agent.tool_call", "agent.complete", "agent.error"
    ]
    
    max_payload_size_bytes: int = 10_000_000  # 10MB
```

---

## 6. Time-Series & Event Storage

### 6.1 ClickHouse for Analytics

ClickHouse is Eden's primary analytical database for time-series metrics:

```sql
-- Agent performance metrics table
CREATE TABLE metrics.agent_performance (
    timestamp DateTime64(3),
    tenant_id LowCardinality(String),
    job_id String,
    agent_name LowCardinality(String),
    pipeline_stage LowCardinality(String),
    
    -- Latency metrics
    duration_ms UInt32,
    queue_time_ms UInt32,
    
    -- Token metrics
    input_tokens UInt32,
    output_tokens UInt32,
    total_tokens UInt32,
    
    -- Cost metrics
    cost_usd Decimal(10, 6),
    
    -- Quality metrics
    success UInt8,  -- 0/1
    review_score Decimal(3, 1),
    test_pass_rate Decimal(4, 3),
    
    -- Dimensions
    model_family LowCardinality(String),
    environment_class LowCardinality(String),
    framework LowCardinality(String)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, environment_class, timestamp);
```

### 6.2 Materialized Views for Dashboards

```sql
-- Pre-aggregated daily metrics
CREATE MATERIALIZED VIEW metrics.daily_performance
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (tenant_id, date, environment_class)
AS SELECT
    toDate(timestamp) as date,
    tenant_id,
    environment_class,
    count() as total_runs,
    sum(success) as successful_runs,
    avg(duration_ms) as avg_duration_ms,
    quantile(0.95)(duration_ms) as p95_duration_ms,
    sum(cost_usd) as total_cost_usd,
    avg(test_pass_rate) as avg_pass_rate
FROM metrics.agent_performance
GROUP BY date, tenant_id, environment_class;
```

### 6.3 Operational Query Patterns

```sql
-- Today's cost per tenant
SELECT tenant_id, sum(cost_usd) 
FROM metrics.agent_performance 
WHERE toDate(timestamp) = today()
GROUP BY tenant_id;

-- Pass rate trend (last 30 days)
SELECT toDate(timestamp) as date, 
       avg(test_pass_rate)
FROM metrics.agent_performance
WHERE timestamp > now() - INTERVAL 30 DAY
GROUP BY date
ORDER BY date;

-- Slowest pipeline stages (P95 latency)
SELECT pipeline_stage, quantile(0.95)(duration_ms) as p95_ms
FROM metrics.agent_performance
WHERE timestamp > now() - INTERVAL 7 DAY
GROUP BY pipeline_stage
ORDER BY p95_ms DESC;
```

---

## 7. Data Retention & Archival

### 7.1 Retention Policy Matrix

| Data Type | Hot (7d) | Warm (90d) | Cold (7yr) | Delete |
|-----------|-----------|------------|------------|--------|
| Raw traces | ✓ | ✓ (Parquet) | ✓ (scrubbed) | After 7yr |
| Derived metrics | ✓ | ✓ | ✓ | After 7yr |
| User feedback | ✓ | ✓ | ✓ | On request |
| Training datasets | ✓ | ✓ | ✓ | After 7yr |
| PII fields | ✓ | — | — | After 30d |
| Audit logs | ✓ | ✓ | ✓ | After 7yr |
| Error logs | ✓ | ✓ | — | After 90d |
| Debug dumps | ✓ | — | — | After 7d |

### 7.2 Automated Purging

```python
# eden/data/retention.py
class DataRetentionManager:
    """Enforces retention policies across all storage tiers."""
    
    async def purge_pii_fields(self, before_date: datetime):
        """Redact PII from traces older than 30 days."""
        await self.iceberg.merge_into(
            table="silver.agent_traces",
            set={"payload": "REDACTED", "user_message": None},
            where=f"ingested_at < '{before_date.isoformat()}'"
        )
    
    async def archive_to_cold(self, before_date: datetime):
        """Move warm data to cold storage."""
        await self.s3.move_to_glacier(
            prefix=f"traces/year={before_date.year}/month={before_date.month:02d}",
            storage_class="GLACIER_IR"
        )
    
    async def delete_user_data(self, tenant_id: str):
        """GDPR right to be forgotten."""
        # Iceberg supports record-level deletes
        await self.iceberg.delete(
            table="bronze.agent_traces",
            where=f"tenant_id = '{tenant_id}'"
        )
        await self.iceberg.delete(
            table="silver.agent_traces",
            where=f"tenant_id = '{tenant_id}'"
        )
        await self.clickhouse.delete(
            table="metrics.agent_performance",
            where=f"tenant_id = '{tenant_id}'"
        )
```

---

## 8. GDPR & Compliance

### 8.1 Compliance by Design

| Requirement | Implementation |
|-------------|----------------|
| **Right to be forgotten** | Record-level delete in Iceberg + cascading deletes in PostgreSQL + ClickHouse |
| **Data portability** | Export API generates Parquet/CSV of all user data within 24 hours |
| **Consent tracking** | Every data point tagged with consent version + timestamp |
| **Anonymization** | PII scrubbed in Silver layer; ML datasets use differential privacy (ε < 1.0) |
| **Audit trail** | All data access logged in tamper-proof append-only table |
| **Breach notification** | Automated PII detection + alerting; 72-hour notification workflow |

### 8.2 PII Detection & Masking

```python
# eden/data/pii.py
class PIIMasker:
    """Detects and masks PII in trace payloads."""
    
    PATTERNS = {
        'email': r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b',
        'phone': r'\b\d{3}[-.]?\d{3}[-.]?\d{4}\b',
        'ssn': r'\b\d{3}-\d{2}-\d{4}\b',
        'credit_card': r'\b(?:\d[ -]*?){13,16}\b',
        'api_key': r'sk-[a-zA-Z0-9]{48}',
    }
    
    async def mask(self, text: str) -> str:
        # Rule-based masking
        for pii_type, pattern in self.PATTERNS.items():
            text = re.sub(pattern, f'[{pii_type.upper()}_REDACTED]', text)
        
        # ML-based NER for remaining PII
        entities = await self.ner_model.predict(text)
        for entity in entities:
            if entity.label in ('PERSON', 'ORG', 'ADDRESS'):
                text = text.replace(entity.text, f'[{entity.label}_REDACTED]')
        
        return text
```

### 8.3 Access Control

```sql
-- Row-level security in ClickHouse (via views)
CREATE VIEW metrics.agent_performance_tenant_isolated AS
SELECT * FROM metrics.agent_performance
WHERE tenant_id = currentTenant();  -- Set by application layer

-- Column-level masking
CREATE VIEW silver.agent_traces_masked AS
SELECT
    trace_id,
    tenant_id,
    job_id,
    event_type,
    CASE 
        WHEN has_permission('view_raw_payload') THEN payload
        ELSE 'REDACTED'
    END as payload,
    ingested_at
FROM silver.agent_traces;
```

---

## 9. Data Lineage

### 9.1 Purpose
Track the complete lifecycle of data: from raw trace → cleaned trace → training dataset → fine-tuned model → better environment. When a model produces bad output, trace it back to the training data that caused it.

### 9.2 Lineage Graph

```
Raw Trace (Kafka)
    │
    ├──→ Bronze Table (Iceberg) ──→ Silver Table (dbt) ──→ Gold: Training Dataset
    │                                                          │
    │                              Silver: Metrics Table       ├──→ Fine-tuning Job
    │                                       │                       │
    │                                       └──→ Gold: Benchmark    └──→ Model Artifact
    │                                                    │                │
    │                                                    └──→ Evaluation ──┘
    │
    └──→ ClickHouse (aggregated metrics) ──→ Dashboard
```

### 9.3 OpenLineage Integration

```python
# eden/data/lineage.py
from openlineage.client import OpenLineageClient

class LineageTracker:
    """Emits OpenLineage events for every data transformation."""
    
    async def track_dbt_run(self, run_result):
        self.client.emit(
            RunEvent(
                eventType=RunState.COMPLETE,
                run=Run(runId=run_result.run_id),
                job=Job(namespace="eden", name=f"dbt.{run_result.model_name}"),
                inputs=[
                    Dataset(namespace="iceberg", name=f"silver.{run_result.source_table}")
                ],
                outputs=[
                    Dataset(namespace="iceberg", name=f"gold.{run_result.model_name}")
                ]
            )
        )
```

### 9.4 DataHub Catalog
All tables, datasets, and ML artifacts registered in DataHub:
- **Search:** "Find all datasets derived from agent traces"
- **Impact analysis:** "If I change the Bronze schema, what breaks?"
- **Ownership:** Every dataset has an owner team
- **Quality scores:** Data quality metrics visible in catalog

---

## 10. Implementation Roadmap

### Phase 1: Foundation (Weeks 1-4)
- [ ] Kafka cluster deployment (3-node minimum)
- [ ] Iceberg catalog setup (REST catalog on PostgreSQL)
- [ ] Bronze layer: Raw trace ingestion from Kafka → S3 Parquet
- [ ] Basic ClickHouse schema for operational metrics
- [ ] S3 lifecycle policies for tiering

### Phase 2: Processing (Weeks 5-8)
- [ ] dbt project setup with Bronze → Silver → Gold transformations
- [ ] Great Expectations integration for data quality
- [ ] PII detection and masking pipeline
- [ ] Materialized views in ClickHouse for dashboards
- [ ] DataHub deployment for lineage tracking

### Phase 3: Intelligence (Weeks 9-12)
- [ ] Automated training dataset generation from Gold tables
- [ ] Data retention automation (PII purging, archival)
- [ ] GDPR deletion workflow (right to be forgotten)
- [ ] Advanced anomaly detection (Soda Core)
- [ ] Cost optimization (tiered storage analysis)

---

## Cross-References

| This Document References | For |
|--------------------------|-----|
| [`eden-observability-and-knowledge-architecture.md`](./eden-observability-and-knowledge-architecture.md) | Trace schema, dataset generation, insights engine |
| [`eden-llmops-experiment-architecture.md`](./eden-llmops-experiment-architecture.md) | Model artifact storage, training data curation, experiment tracking |
| [`eden-security-architecture.md`](./eden-security-architecture.md) | PII handling, encryption, access control, audit logging |
| [`eden-cost-optimization-architecture.md`](./eden-cost-optimization-architecture.md) | Storage cost optimization, query cost attribution |
| [`eden-integration-dominance-architecture.md`](./eden-integration-dominance-architecture.md) | Core pipeline architecture, data flow between nodes |
