# Eden — Infrastructure & Deployment Architecture

> **Date:** May 29, 2026  
> **Purpose:** Define how Eden is deployed, scaled, monitored, and operated as a production-grade platform — covering Kubernetes patterns, infrastructure as code, GitOps, disaster recovery, monitoring, incident response, and FinOps.

---

## Table of Contents

1. [Strategic Thesis](#1-strategic-thesis)
2. [Architecture Overview](#2-architecture-overview)
3. [Kubernetes for AI Workloads](#3-kubernetes-for-ai-workloads)
4. [Infrastructure as Code](#4-infrastructure-as-code)
5. [GitOps & CI/CD for Infrastructure](#5-gitops--cicd-for-infrastructure)
6. [Disaster Recovery & Backup](#6-disaster-recovery--backup)
7. [Monitoring & Observability](#7-monitoring--observability)
8. [Incident Response](#8-incident-response)
9. [Cost Management (FinOps)](#9-cost-management-finops)
10. [Regional Deployment & Data Residency](#10-regional-deployment--data-residency)
11. [Implementation Roadmap](#11-implementation-roadmap)

---

## 1. Strategic Thesis

Eden is a compute-intensive, latency-sensitive, multi-tenant platform. The infrastructure must:

1. **Scale dynamically:** From 1 job/day to 10,000 jobs/hour without human intervention
2. **Survive failures:** Region outages, provider degradation, and cluster failures must be transparent to users
3. **Protect data:** Tenant data must never leak between boundaries, even during failover
4. **Control costs:** Every dollar spent must be justified and attributed
5. **Deploy safely:** Infrastructure changes must be tested, reviewed, and rolled back automatically if they cause degradation

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GLOBAL LAYER                                       │
│  Cloudflare DNS + Load Balancer  →  API Gateway (Kong/AWS API GW)         │
│  Multi-region traffic routing    →  Health checks + failover               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
│    US-WEST (Oregon) │ │    US-EAST (Virginia)│ │    EU-WEST (Ireland)│
│                     │ │                     │ │                     │
│  ┌───────────────┐ │ │  ┌───────────────┐ │ │  ┌───────────────┐ │
│  │   EKS/GKE     │ │ │  │   EKS/GKE     │ │ │  │   EKS/GKE     │ │
│  │   Cluster     │ │ │  │   Cluster     │ │ │  │   Cluster     │ │
│  │               │ │ │  │               │ │ │  │               │ │
│  │ ┌───────────┐ │ │  │ ┌───────────┐ │ │  │ ┌───────────┐ │ │
│  │ │ API Pods  │ │ │  │ │ API Pods  │ │ │  │ │ API Pods  │ │ │
│  │ │ (FastAPI) │ │ │  │ │ (FastAPI) │ │ │  │ │ (FastAPI) │ │ │
│  │ └───────────┘ │ │  │ └───────────┘ │ │  │ └───────────┘ │ │
│  │ ┌───────────┐ │ │  │ ┌───────────┐ │ │  │ ┌───────────┐ │ │
│  │ │Worker Pods│ │ │  │ │Worker Pods│ │ │  │ │Worker Pods│ │ │
│  │ │(Celery/RQ)│ │ │  │ │(Celery/RQ)│ │ │  │ │(Celery/RQ)│ │ │
│  │ └───────────┘ │ │  │ └───────────┘ │ │  │ └───────────┘ │ │
│  │ ┌───────────┐ │ │  │ ┌───────────┐ │ │  │ ┌───────────┐ │ │
│  │ │Sandbox    │ │ │  │ │Sandbox    │ │ │  │ │Sandbox    │ │ │
│  │ │Namespace  │ │ │  │ │Namespace  │ │ │  │ │Namespace  │ │ │
│  │ │(gVisor)   │ │ │  │ │(gVisor)   │ │ │  │ │(gVisor)   │ │ │
│  │ └───────────┘ │ │  │ └───────────┘ │ │  │ └───────────┘ │ │
│  └───────────────┘ │ │  └───────────────┘ │ │  └───────────────┘ │
│                     │ │                     │ │                     │
│  ┌───────────────┐ │ │  ┌───────────────┐ │ │  ┌───────────────┐ │
│  │  PostgreSQL   │ │ │  │  PostgreSQL   │ │ │  │  PostgreSQL   │ │
│  │  (Primary)    │ │ │  │  (Replica)    │ │ │  │  (Replica)    │ │
│  └───────────────┘ │ │  └───────────────┘ │ │  └───────────────┘ │
│                     │ │                     │ │                     │
│  ┌───────────────┐ │ │  ┌───────────────┐ │ │  ┌───────────────┐ │
│  │    Redis      │ │ │  │    Redis      │ │ │  │    Redis      │ │
│  │  (Cache +     │ │ │  │  (Cache +     │ │ │  │  (Cache +     │ │
│  │   Queue)      │ │ │  │   Queue)      │ │ │  │   Queue)      │ │
│  └───────────────┘ │ │  └───────────────┘ │ │  └───────────────┘ │
└─────────────────────┘ └─────────────────────┘ └─────────────────────┘
```

---

## 3. Kubernetes for AI Workloads

### 3.1 Cluster Architecture

```yaml
# eden-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: eden
  labels:
    istio-injection: enabled
    pod-security.kubernetes.io/enforce: restricted
---
# Sandbox namespace (more isolated)
apiVersion: v1
kind: Namespace
metadata:
  name: eden-sandbox
  labels:
    pod-security.kubernetes.io/enforce: restricted
    sandbox.eden.ai/isolated: "true"
```

### 3.2 GPU Node Pools

```yaml
# gpu-node-pool.yaml
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: gpu-inference
spec:
  template:
    spec:
      requirements:
        - key: node.kubernetes.io/instance-type
          operator: In
          values: ["g5.xlarge", "g5.2xlarge", "p4d.24xlarge"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand", "spot"]
      taints:
        - key: nvidia.com/gpu
          value: "true"
          effect: NoSchedule
  limits:
    cpu: 1000
    memory: 4000Gi
    nvidia.com/gpu: 100
  disruption:
    consolidationPolicy: WhenEmpty
    expireAfter: 720h  # 30 days max node lifetime
```

### 3.3 Intelligent Auto-Scaling

```yaml
# KEDA scaled object for API pods
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: eden-api-scaler
spec:
  scaleTargetRef:
    name: eden-api
  minReplicaCount: 3
  maxReplicaCount: 100
  triggers:
    # Scale on request queue depth
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring:9090
        metricName: http_requests_queue_depth
        threshold: "50"
        query: sum(rate(http_requests_queue_depth{service="eden-api"}[2m]))
    # Scale on active job count
    - type: prometheus
      metadata:
        metricName: active_jobs
        threshold: "20"
        query: sum(eden_active_jobs)
    # Scale on custom LLM latency metric
    - type: prometheus
      metadata:
        metricName: llm_p95_latency_ms
        threshold: "2000"
        query: histogram_quantile(0.95, rate(llm_request_duration_ms_bucket[5m]))
```

### 3.4 Pod Disruption Budgets

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: eden-api-pdb
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: eden-api
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: eden-worker-pdb
spec:
  minAvailable: 50%
  selector:
    matchLabels:
      app: eden-worker
```

### 3.5 Resource Quotas per Tenant

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tenant-acme-corp
  namespace: eden-sandbox-tenant-acme-corp
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 40Gi
    limits.cpu: "20"
    limits.memory: 80Gi
    pods: "50"
    requests.nvidia.com/gpu: "2"
    persistentvolumeclaims: "10"
```

---

## 4. Infrastructure as Code

### 4.1 Terraform Module Structure

```
terraform/
├── modules/
│   ├── vpc/                    # Networking foundation
│   ├── eks/                    # Kubernetes cluster
│   ├── rds/                    # PostgreSQL databases
│   ├── elasticache/            # Redis clusters
│   ├── s3/                     # Object storage + lifecycle
│   ├── iam/                    # Roles and policies
│   ├── kms/                    # Encryption keys
│   ├── cloudfront/             # CDN for artifacts
│   ├── keda/                   # Auto-scaling
│   └── sandbox/                # gVisor + Firecracker setup
├── environments/
│   ├── production/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── terraform.tfvars
│   ├── staging/
│   └── development/
└── global/
    └── dns.tf                  # Route53 / Cloudflare
```

### 4.2 Pulumi Alternative (Python-native)

```python
# pulumi/__main__.py
import pulumi
from pulumi_aws import eks, rds, s3

# EKS Cluster
cluster = eks.Cluster(
    "eden-cluster",
    version="1.30",
    instance_type="m6i.2xlarge",
    desired_capacity=3,
    min_size=3,
    max_size=20,
    node_associated_policy_arns=[
        "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
        "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    ]
)

# RDS PostgreSQL
postgres = rds.Instance(
    "eden-postgres",
    engine="postgres",
    engine_version="16.3",
    instance_class="db.r6g.xlarge",
    allocated_storage=100,
    storage_type="gp3",
    multi_az=True,
    backup_retention_period=30,
    encryption_at_rest=True,
    kms_key_id=kms_key.id,
    deletion_protection=True
)

# S3 Buckets with lifecycle
artifacts_bucket = s3.Bucket(
    "eden-artifacts",
    versioning={"enabled": True},
    lifecycle_rules=[
        {
            "id": "hot-to-warm",
            "enabled": True,
            "transition": {"days": 7, "storage_class": "STANDARD_IA"},
        },
        {
            "id": "warm-to-cold",
            "enabled": True,
            "transition": {"days": 90, "storage_class": "GLACIER_IR"},
        },
    ]
)

pulumi.export("cluster_endpoint", cluster.endpoint)
pulumi.export("postgres_endpoint", postgres.endpoint)
```

### 4.3 Multi-Region Replication

```hcl
# terraform/modules/rds/replica.tf
resource "aws_db_instance_automated_backups_replication" "cross_region" {
  source_db_instance_arn = aws_db_instance.primary.arn
  retention_period       = 30
  kms_key_id            = aws_kms_key.replica.arn
  provider              = aws.us-east-1  # Replica in different region
}

# S3 Cross-Region Replication
resource "aws_s3_bucket_replication_configuration" "artifacts" {
  role   = aws_iam_role.replication.arn
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "replicate-to-secondary"
    status = "Enabled"
    priority = 1

    destination {
      bucket = aws_s3_bucket.artifacts_secondary.arn
      replication_time {
        status  = "Enabled"
        minutes = 15
      }
      metrics {
        status  = "Enabled"
        minutes = 15
      }
    }
  }
}
```

---

## 5. GitOps & CI/CD for Infrastructure

### 5.1 ArgoCD Setup

```yaml
# argocd/applications/eden-platform.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: eden-platform
  namespace: argocd
spec:
  project: eden
  source:
    repoURL: https://github.com/eden-platform/infrastructure.git
    targetRevision: HEAD
    path: k8s/overlays/production
  destination:
    server: https://kubernetes.default.svc
    namespace: eden
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
      allowEmpty: false
    syncOptions:
      - CreateNamespace=true
      - PrunePropagationPolicy=foreground
      - PruneLast=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

### 5.2 Infrastructure PR Workflow

```
Developer opens PR → Terraform Plan posted as PR comment
                        ↓
           Reviewer approves → Terraform Apply on merge
                        ↓
           ArgoCD detects drift → Auto-syncs cluster state
                        ↓
           Smoke tests run → Rollback if health checks fail
```

### 5.3 Drift Detection

```python
# eden/infra/drift_detector.py
class DriftDetector:
    """Detects when actual infrastructure diverges from IaC definitions."""
    
    async def detect_drift(self, environment: str) -> list[DriftReport]:
        # Run terraform plan -detailed-exitcode
        plan = await self.terraform.plan(
            env=environment,
            detailed_exitcode=True
        )
        
        if plan.exit_code == 2:  # Changes detected
            return self.parse_drift(plan.output)
        
        return []
    
    async def alert_on_drift(self, drifts: list[DriftReport]):
        for drift in drifts:
            await self.slack.notify(
                channel="#infra-alerts",
                message=f"🚨 Infrastructure drift detected in {drift.environment}",
                details=drift.details
            )
```

---

## 6. Disaster Recovery & Backup

### 6.1 RPO / RTO Targets

| Data Type | RPO | RTO | Strategy |
|-----------|-----|-----|----------|
| Job metadata | 5 min | 15 min | Streaming replication + automated failover |
| User data (KB) | 5 min | 15 min | Streaming replication + automated failover |
| Generated artifacts | 1 hour | 4 hours | S3 cross-region replication |
| Metrics (ClickHouse) | 15 min | 1 hour | Shard replication + backup restore |
| LLM traces | 15 min | 2 hours | Kafka log retention + consumer replay |

### 6.2 Backup Strategy

```python
# eden/infra/backup.py
class BackupManager:
    """Manages backups across all data stores."""
    
    async def backup_postgres(self):
        """Automated daily backups with point-in-time recovery."""
        await self.rds.create_snapshot(
            instance_id="eden-postgres-primary",
            snapshot_id=f"eden-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}"
        )
    
    async def backup_clickhouse(self):
        """Shard-level backups to S3."""
        for shard in self.clickhouse.shards:
            await shard.backup_to_s3(
                bucket="eden-clickhouse-backups",
                path=f"{shard.id}/{datetime.utcnow().isoformat()}/"
            )
    
    async def restore_postgres(self, target_time: datetime):
        """Point-in-time recovery to any second in the last 30 days."""
        snapshot = await self.rds.find_snapshot_before(target_time)
        await self.rds.restore_from_snapshot(
            snapshot_id=snapshot.id,
            target_time=target_time,
            new_instance_id="eden-postgres-recovery"
        )
```

### 6.3 Multi-Region Failover

```python
class FailoverManager:
    """Automated failover between regions."""
    
    REGIONS = ["us-west-2", "us-east-1", "eu-west-1"]
    
    async def health_check(self, region: str) -> RegionHealth:
        """Check health of a region."""
        checks = await asyncio.gather(
            self.check_api_health(region),
            self.check_db_health(region),
            self.check_worker_health(region),
            self.check_sandbox_health(region)
        )
        return RegionHealth(
            region=region,
            healthy=all(c.healthy for c in checks),
            details=checks
        )
    
    async def failover(self, from_region: str, to_region: str):
        """Route traffic from failed region to healthy region."""
        # Update DNS/Load Balancer
        await self.cloudflare.update_pool(
            origin=f"api.{from_region}.eden.ai",
            enabled=False
        )
        
        # Promote DB replica to primary
        await self.rds.promote_replica(
            instance_id=f"eden-postgres-{to_region}"
        )
        
        # Notify users
        await self.statuspage.create_incident(
            title=f"Failover from {from_region} to {to_region}",
            status="monitoring"
        )
```

---

## 7. Monitoring & Observability

### 7.1 SLIs & SLOs

| Service | SLI | SLO | Alert Threshold |
|---------|-----|-----|----------------|
| API | P99 latency | <500ms | >750ms |
| API | Error rate | <0.1% | >0.5% |
| Job Worker | Success rate | >99% | <95% |
| Job Worker | Queue depth | <100 | >500 |
| Sandbox | Startup time | <2s | >5s |
| Sandbox | Escape attempts | 0 | Any |
| KB Retrieval | P99 latency | <50ms | >100ms |
| LLM Gateway | Provider failover | <1% | >5% |

### 7.2 Prometheus Metrics

```yaml
# prometheus/rules/eden-alerts.yml
groups:
  - name: eden-api
    rules:
      - alert: EdenHighLatency
        expr: histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m])) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Eden API P99 latency is high"
          
      - alert: EdenHighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.001
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Eden API error rate exceeds 0.1%"
          
      - alert: EdenSandboxEscape
        expr: increase(sandbox_escape_attempts_total[5m]) > 0
        for: 0m
        labels:
          severity: critical
        annotations:
          summary: "Sandbox escape attempt detected"
```

### 7.3 Grafana Dashboards

| Dashboard | Panels |
|-----------|--------|
| **Platform Overview** | Active jobs, queue depth, success rate, cost/hour |
| **API Performance** | RPS, latency percentiles, error rates, by endpoint |
| **LLM Gateway** | Token usage, provider health, cost per model, cache hit rate |
| **Sandbox** | Container count, startup time, escape attempts, resource usage |
| **Multi-Region** | Traffic split, regional latency, failover status |
| **Cost** | Spend per tenant, per service, per model, budget burn rate |

---

## 8. Incident Response

### 8.1 Severity Levels

| Level | Criteria | Response Time | Escalation |
|-------|----------|--------------|------------|
| **SEV-1** | Platform down, all tenants affected, data loss risk | 5 min | Page on-call immediately |
| **SEV-2** | Degraded performance >50% of tenants, or sandbox escape | 15 min | Page on-call + team lead |
| **SEV-3** | Feature broken for subset of tenants | 1 hour | Slack alert, next business day |
| **SEV-4** | Minor bug, cosmetic issue | 1 day | Ticket, next sprint |
| **SEV-5** | Alert fatigue, false positive | 1 week | Weekly review |

### 8.2 Incident Playbooks

#### Playbook: LLM Provider Outage
```
1. DETECT: Alert fires (provider error rate >10%)
2. TRIAGE: Verify provider status page
3. MITIGATE: Activate circuit breaker, route to fallback provider
4. COMMUNICATE: Update status page, notify affected tenants
5. RESOLVE: Monitor fallback provider health
6. POST-MORTEM: Document within 24 hours
```

#### Playbook: Database Primary Failure
```
1. DETECT: Health check fails (connection timeout)
2. TRIAGE: Verify with manual DB connection test
3. MITIGATE: Promote read replica to primary (automated)
4. COMMUNICATE: Status page update
5. RESOLVE: Verify writes succeeding on new primary
6. POST-MORTEM: Root cause analysis within 48 hours
```

#### Playbook: Sandbox Escape
```
1. DETECT: Security alert (syscall policy violation)
2. TRIAGE: Isolate affected node immediately
3. MITIGATE: Kill all pods on affected node, drain node
4. COMMUNICATE: Notify security team + legal
5. INVESTIGATE: Analyze exploit, patch gVisor policy
6. RESOLVE: Rebuild node with patched policy
```

### 8.3 Automated Mitigation

```python
class AutoMitigator:
    """Automatically responds to common incidents."""
    
    async def handle_provider_outage(self, provider: str):
        # Circuit breaker already tripped by gateway
        # Just need to notify and scale fallback
        await self.scale_fallback_provider(factor=2.0)
        await self.notify_tenants(
            message=f"Temporary routing to backup provider due to {provider} outage"
        )
    
    async def handle_high_latency(self, service: str):
        # Auto-scale if queue depth is high
        queue_depth = await self.get_queue_depth(service)
        if queue_depth > 500:
            await self.keda_scale(service, replicas=+10)
    
    async def handle_memory_pressure(self, node: str):
        # Evict lowest-priority pods
        pods = await self.get_pods_by_priority(node)
        for pod in pods:
            if pod.priority < 1000:  # Non-critical
                await self.evict_pod(pod)
                if await self.memory_pressure_resolved(node):
                    break
```

---

## 9. Cost Management (FinOps)

### 9.1 Cost Attribution Dimensions

| Dimension | Granularity | Tool |
|-----------|-------------|------|
| **Tenant** | Per organization | Tags on all resources |
| **Service** | Per microservice | Kubernetes namespace labels |
| **Environment** | Per job | Job metadata in billing events |
| **Model** | Per LLM call | AI Gateway tracking |
| **Region** | Per AWS/GCP region | Cloud provider tags |

### 9.2 Reserved vs Spot Instances

```yaml
# karpenter node pool with mixed capacity
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: mixed-workloads
spec:
  template:
    spec:
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand", "spot"]
  # 70% spot for non-critical batch jobs
  # 30% on-demand for latency-sensitive API
```

### 9.3 Cost Alerts

```yaml
# Prometheus recording rules for cost
- record: eden:cost_per_hour:tenant
  expr: |
    sum by (tenant_id) (
      aws_ec2_instance_cost *
      on (instance_id) group_left(tenant_id) kube_node_labels
    )

# Alert when tenant exceeds 80% of budget
- alert: TenantBudgetWarning
  expr: eden:cost_per_hour:tenant > tenant_budget_limit * 0.8
  for: 1h
  labels:
    severity: warning
  annotations:
    summary: "Tenant {{ $labels.tenant_id }} approaching budget limit"
```

---

## 10. Regional Deployment & Data Residency

### 10.1 Deployment Topology

| Region | Primary Services | Tenant Data |
|--------|-----------------|-------------|
| **us-west-2** | API, Workers, Sandbox | US tenants |
| **us-east-1** | API, Workers, Sandbox | US tenants (DR) |
| **eu-west-1** | API, Workers, Sandbox | EU tenants (GDPR) |
| **ap-southeast-1** | API, Workers | APAC tenants |

### 10.2 Data Residency Enforcement

```python
class DataResidencyEnforcer:
    """Ensures tenant data never leaves their designated region."""
    
    REGION_MAP = {
        "us": ["us-west-2", "us-east-1"],
        "eu": ["eu-west-1"],
        "apac": ["ap-southeast-1"],
    }
    
    async def route_job(self, tenant_id: str) -> str:
        tenant = await self.get_tenant(tenant_id)
        allowed_regions = self.REGION_MAP[tenant.data_residency_region]
        
        # Pick healthiest allowed region
        healthy = [r for r in allowed_regions if await self.is_healthy(r)]
        return random.choice(healthy)
    
    async def enforce_replication(self, tenant_id: str):
        """Block cross-region replication for EU tenants."""
        tenant = await self.get_tenant(tenant_id)
        if tenant.data_residency_region == "eu":
            await self.s3.block_cross_region_replication(
                bucket=f"eden-data-{tenant_id}"
            )
```

---

## 11. Implementation Roadmap

### Phase 1: Foundation (Months 1-3)
- [ ] Single-region Kubernetes cluster (EKS/GKE)
- [ ] PostgreSQL primary + replica
- [ ] Redis for caching and queues
- [ ] S3 for artifacts with lifecycle policies
- [ ] Basic Prometheus + Grafana monitoring

### Phase 2: Scale (Months 4-6)
- [ ] KEDA auto-scaling for all services
- [ ] GPU node pools with MIG/time-slicing
- [ ] gVisor sandbox namespace isolation
- [ ] Multi-region PostgreSQL replication
- [ ] ArgoCD GitOps deployment

### Phase 3: Resilience (Months 7-9)
- [ ] Automated failover between regions
- [ ] Disaster recovery runbooks (quarterly drills)
- [ ] Advanced FinOps with cost attribution
- [ ] Istio service mesh for internal traffic
- [ ] Automated incident response (self-healing)

---

## Cross-References

| This Document References | For |
|--------------------------|-----|
| [`eden-security-architecture.md`](./eden-security-architecture.md) | Sandbox security, network policies, encryption |
| [`eden-multi-tenancy-billing-architecture.md`](./eden-multi-tenancy-billing-architecture.md) | Tenant isolation in Kubernetes, resource quotas, billing |
| [`eden-cost-optimization-architecture.md`](./eden-cost-optimization-architecture.md) | Model routing, caching, compute optimization |
| [`eden-data-platform-architecture.md`](./eden-data-platform-architecture.md) | Data retention, archival, cross-region replication |
| [`eden-realtime-streaming-architecture.md`](./eden-realtime-streaming-architecture.md) | Event streaming infrastructure, Kafka deployment |
