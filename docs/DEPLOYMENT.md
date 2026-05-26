# Eden Cloud Deployment Guide

## Table of Contents

- [Provider Comparison](#provider-comparison)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Detailed Setup](#detailed-setup)
- [Kubernetes Scaling](#kubernetes-scaling)
- [Database Scaling](#database-scaling)
- [Multi-Org Scaling](#multi-org-scaling)
- [Security](#security)
- [Monitoring](#monitoring)
- [Cost Optimization](#cost-optimization)
- [Eden SaaS Pricing Model](#eden-saas-pricing-model)
- [Multi-Tenant Database Architecture](#multi-tenant-database-architecture)
- [GitOps Deployment with ArgoCD](#gitops-deployment-with-argocd)
- [Sandbox Isolation: Firecracker Best Practices](#sandbox-isolation-firecracker-best-practices)
- [Observability Stack](#observability-stack)
- [Troubleshooting](#troubleshooting)

---

## Provider Comparison

### Full Provider Landscape (2026)

| Provider | Managed K8s | Best For | Compute $/vCPU-mo | Free Tier |
|----------|-------------|----------|-------------------|-----------|
| **GCP GKE Autopilot** | $0 control plane | Scale-to-zero SaaS | ~$25 | $300 credits |
| **GCP GKE Standard** | $73/mo control plane | Predictable workloads | ~$25 | $300 credits |
| **AWS EKS** | $73/mo + Fargate premium | AWS ecosystem | ~$28 (EC2) | 12mo free tier |
| **AWS EKS + Fargate** | $73/mo | Serverless containers | ~$38 | Limited |
| **Azure AKS** | Free | Microsoft shops | ~$35 | $200 credits |
| **DigitalOcean DOKS** | Free | Small teams | ~$24 | $200 credits |
| **Vultr VKE** | Free | Global edge deploy | ~$20 | $100 credits |
| **Linode LKE** | Free | Budget K8s | ~$22 | $100 credits |
| **Civo** | Free | K3s-based | ~$21 | £75 credits |
| **Oracle OKE** | Free | Oracle ecosystem | ~$20 | Always-free tier |

### Self-Managed / PaaS Options

| Platform | Best For | PostgreSQL | Auto-scale | Egress |
|----------|----------|-----------|------------|--------|
| **Railway** | Fast deploys | $25/mo bundled | Yes (paid) | $0.10/GB |
| **Render** | Simple apps | $7/mo + 0.5ACU | Yes (auto) | $0.10/GB |
| **Fly.io** | Edge deploys | $5/mo pg + 3.5ACU | Yes | $0.15/GB |
| **Heroku** | Legacy apps | $50/mo | Limited | $0.09/GB |
| **Render** | Static + Docker | $7/mo | Yes | Included |
| **Platform.sh** | Enterprise PHP/Node | $10/mo | Yes | Custom |
| **Windmill** | Internal tools | Custom | Yes | Custom |
| **Coolify** | Self-hosted | Custom | Yes | Unlimited |

### European Providers

| Provider | K8s | Best For | Regions | Notes |
|----------|-----|----------|---------|-------|
| **OVHcloud** | OVHcloud MKS | EU compliance | 30+ EU | Free control plane, cheap nodes |
| **Scaleway** | Kapsule | EU, cost-conscious | EU+ | €33/mo entry, free control plane |
| **Exoscale** | SKS | Swiss/Enterprise | EU | €68/mo, ISO 27001, BSI C5 |
| **IONOS** | K8s | German enterprises | EU | Free control plane, DCSO approved |
| **Hetzner** | Self-managed | Budget EU | EU | €4.49/mo entry, 20TB egress free |
| **netcup** | Self-managed | German SME | EU | €5.99/mo entry, 99,500 IOPS |
| **Infomaniak** | Managed K8s | Swiss | EU | CHF 8.50/mo, ISO 27001 |

### GPU/AI Infrastructure

| Provider | GPU Options | Best For | Starting Price |
|----------|-------------|----------|----------------|
| **CoreWeave** | H100, B200, GB200 | AI training/inference | $1.99/hr A100 |
| **DigitalOcean GPU** | H100, H200, MI300X | Bare metal AI | Contact sales |
| **OVHcloud GPU** | L4, L40S | AI inference | ~$400/mo |
| **Oracle RTX PRO** | RTX PRO 6000 | Multimodal AI | $4.50/GPU-hr |
| **Lambda Labs** | H100, A100 | Training | $1.49/hr A100 |
| **Crusoe** | H100, B200 | AI workloads | $2.75/hr H100 |
| **Vultr** | A100, L40S | Inference | $2.00/hr A100 |

---

### Additional Provider Deep-Dives

#### Civo Cloud

**Best for**: K3s fans, European workloads, clean API

| Spec | Price |
|------|-------|
| Control plane | Free |
| k3s.small (2vCPU, 2GB) | $5.43/mo |
| k3s.medium (4vCPU, 8GB) | $21.60/mo |
| k3s.large (8vCPU, 16GB) | $43.20/mo |
| Load balancer | $11/mo |
| **Total small** | ~$17/mo |
| **Total medium** | ~$55/mo |

**Pros**: K3s-based (lighter, faster), 90-second provisioning, no egress fees
**Cons**: Smaller ecosystem, fewer features than DOKS

---

#### Oracle Cloud Infrastructure (OCI) OKE

**Best for**: Budget enterprise, Oracle shops, long-term cost savings

| Spec | Price |
|------|-------|
| Control plane | Free |
| VM.Standard3 (2vCPU, 8GB) | ~$18/mo |
| VM.Standard.E4.Flex (4vCPU, 16GB) | ~$36/mo |
| Always-Free (1GB, 50GB storage) | $0 |
| **Total small** | ~$20/mo |
| **Total medium** | ~$45/mo |

**Pros**: Free control plane, Always-Free tier, dramatically cheaper than AWS/GCP
**Cons**: Complex UI, limited market awareness, Oracle ecosystem lock-in

---

#### OVHcloud Managed Kubernetes (MKS)

**Best for**: EU compliance, GDPR-sensitive, cost-conscious

| Spec | Price |
|------|-------|
| Control plane | Free |
| node-2 (2vCPU, 4GB) | €7.20/mo |
| node-4 (4vCPU, 8GB) | €14.40/mo |
| node-8 (8vCPU, 16GB) | €28.80/mo |
| Load balancer | €4.99/mo |
| **Total small** | ~€25/mo |
| **Total medium** | ~€50/mo |

**Pros**: 30+ EU datacenters, GDPR-compliant, unlimited egress (some plans)
**Cons**: Complex UI, slower support, limited English documentation

---

#### Scaleway Kapsule

**Best for**: EU startups, cost-sensitive, multi-region

| Spec | Price |
|------|-------|
| Control plane | Free |
| POP-2S (2vCPU, 4GB) | €11.99/mo |
| POP-4S (4vCPU, 8GB) | €23.99/mo |
| POP-8S (8vCPU, 16GB) | €47.99/mo |
| Load balancer | €9.99/mo |
| **Total small** | ~€22/mo |
| **Total medium** | ~€48/mo |

**Pros**: Free control plane, EU-owned, Object Storage included
**Cons**: Fewer US regions, occasional reliability issues

---

#### Exoscale SKS

**Best for**: Swiss enterprises, regulated industries, GDPR/HIPAA

| Spec | Price |
|------|-------|
| Control plane | Free |
| Small (4vCPU, 8GB) | €68/mo |
| Medium (8vCPU, 16GB) | €136/mo |
| Enterprise | Custom |
| **Total small** | ~€80/mo |
| **Total medium** | ~€150/mo |

**Pros**: ISO 27001, BSI C5 (German gov), FINMA (Swiss banking), Swiss data residency
**Cons**: Higher price point, smaller ecosystem

---

#### Hostinger K3s VPS

**Best for**: Learning Kubernetes, micro-budget, staging

| Spec | Price |
|------|-------|
| K3s on VPS (2vCPU, 4GB) | $3.99/mo |
| K3s on VPS (4vCPU, 8GB) | $6.99/mo |
| K3s on VPS (8vCPU, 16GB) | $12.99/mo |
| **Total** | $4-13/mo |

**Pros**: Extremely cheap, full K8s API access, 0.15ms latency
**Cons**: Single node (not HA), you manage the control plane

### Serverless PostgreSQL

| Service | Plan | Price | Scale-to-Zero | Connections | Max Storage |
|---------|------|-------|---------------|-------------|-------------|
| **Neon** | Launch | $19/mo | Yes (3 CU) | 50 | 10GB |
| **Neon** | Scale | $69/mo | Yes (6 CU) | 200 | 50GB |
| **Neon** | Enterprise | Custom | Yes | Unlimited | Unlimited |
| **Supabase** | Free | $0 | No | 60 | 500MB |
| **Supabase** | Pro | $25/mo | No | 200 | 8GB |
| **PlanetScale** | Hobby | $39/mo | No | 500 | 30GB |

### Nested Virtualization Support (for Firecracker)

| Provider | Instance Types | Nested Virt | Notes |
|----------|---------------|-------------|-------|
| **GCP c3/n3** | c3-standard-4+ | Yes | On-demand, good for sandboxes |
| **AWS c7i/m7i** | c7i.large+ | Bare metal only | Need bare metal for KVM |
| **Azure D/Ev3** | D4s_v3+ | Yes | Nested enabled by default |
| **DigitalOcean** | c-4+ | No | No nested virt |
| **Vultr** | c-4+ | Yes | AMD EPYC, nested OK |
| **Oracle** | VM.Standard3 | Yes | Free nested virt |

---

### Detailed Analysis (2026)

| Dimension | AWS | GCP (Recommended) | Azure |
|-----------|-----|-------------------|-------|
| **Best For** | Ecosystem breadth, Graviton efficiency | Kubernetes (GKE), data/AI workloads | Microsoft enterprises |
| **Managed K8s** | EKS ($73/mo per cluster) | GKE Autopilot (free control plane) | AKS (free) |
| **Compute (2 vCPU)** | m7g.large ~$55/mo | n4-standard-2 ~$50/mo | D4s v5 ~$70/mo |
| **PostgreSQL (HA)** | RDS ~$320/mo | Cloud SQL ~$290/mo | Azure SQL ~$300/mo |
| **Egress** | High ($0.09/GB) | Moderate ($0.08/GB) | High ($0.087/GB) |
| **Nested Virtualization** | c7i/m7i (bare metal only for Firecracker) | c3/n3 (on-demand) | D/Ev3 (enabled) |

---

### DigitalOcean Kubernetes (DOKS)

**Best for**: Small teams, budget-conscious deployments

| Spec | Price |
|------|-------|
| Control plane | Free |
| 2x s-2vcpu-4gb | $48/mo |
| 4x s-4vcpu-8gb | $192/mo |
| Load balancer | $10/mo |
| Block storage | $10/100GB |
| **Total small** | ~$70/mo |
| **Total medium** | ~$220/mo |

**Pros**: Free control plane, simple UI, $200 free credits
**Cons**: Only 4 regions, limited nested virt

---

### Vultr Kubernetes Engine (VKE)

**Best for**: Global edge deployment, cost-sensitive teams

| Spec | Price |
|------|-------|
| Control plane | Free |
| 2x 4c-8gb AMD | $40/mo |
| 4x 4c-8gb AMD | $160/mo |
| Load balancer | $10/mo |
| Block storage | $5/100GB |
| **Total small** | ~$55/mo |
| **Total medium** | ~$180/mo |

**Pros**: 32 global regions, AMD EPYC, free control plane, $100 credits
**Cons**: Newer to Kubernetes, smaller ecosystem

---

### Railway

**Best for**: Quick deployments, Next.js/Node apps

| Component | Price |
|-----------|-------|
| Micro (0.5 ACU) | $0 |
| Small (1 ACU) | $5/mo |
| Medium (2 ACU) | $10/mo |
| PostgreSQL | $25/mo (bundled) |
| Redis | $5/mo |
| Bandwidth | $0.10/GB |

**Pros**: Instant deploys, built-in DB, great DX
**Cons**: No scale-to-zero, egress costs, limited regions

---

### Render

**Best for**: Static sites, simple Docker apps

| Component | Price |
|-----------|-------|
| Starter (auto-scale) | $7/mo |
| PostgreSQL | $7/mo |
| Redis | $5/mo |
| Bandwidth | $0.10/GB |

**Pros**: Auto-scale included, free SSL, simple setup
**Cons**: Cold starts, no scale-to-zero, limited compute

---

### Fly.io

**Best for**: Edge deployment, low-latency apps

| Component | Price |
|-----------|-------|
| 3x shared-cpu-1x | $5.47/mo |
| Volume (10GB) | $3/mo |
| Anycast | Included |
| PostgreSQL | $5/mo + compute |

**Pros**: 30+ regions, Anycast, volume storage, scale-to-zero
**Cons**: Complex networking model, pg not managed

### GKE Autopilot vs Standard

**Autopilot (Recommended for Eden)**:
- Free control plane (saves $73/mo vs EKS)
- Pay only for pod resources requested
- No idle node costs - scales to zero
- Automatic bin-packing and node provisioning
- Best for: Variable workloads, multi-tenant SaaS

**Standard**:
- Pay for entire nodes regardless of utilization
- Full control over node pools
- Can use Spot VMs for 60-91% savings
- Better for: Predictable high-utilization workloads

**Cost Comparison (10 pods, 2 vCPU / 4GB each)**:

| Mode | Monthly Cost |
|------|-------------|
| Autopilot | ~$200-300 |
| Standard (on-demand) | ~$400 |
| Standard (Spot) | ~$120-200 |
| EKS Fargate | ~$400-550 |

---

### AWS EKS: EC2 vs Fargate

**EC2 (Recommended for cost-sensitive)**:
- Pay for actual EC2 instances
- Use Spot for 60-91% savings
- Full control over node pools
- Need to manage cluster autoscaler

**Fargate**:
- Truly serverless containers
- 38% premium past 200 vCPU-hours/day
- No node management
- Best for: Sporadic workloads, AWS-native teams

**Fargate Economics**:
| Daily Usage | EC2 Cost | Fargate Cost | Premium |
|-------------|----------|--------------|---------|
| 4 vCPU-hours/day | ~$30 | ~$47 | 57% |
| 100 vCPU-hours/day | ~$750 | ~$860 | 15% |
| 500 vCPU-hours/day | ~$3,750 | ~$5,200 | 38% |

### RDS vs Cloud SQL vs Aurora

| Feature | RDS PostgreSQL | Cloud SQL | Aurora PostgreSQL |
|---------|---------------|----------|------------------|
| **Cost** | ~$117/mo (db.t4g.medium) | ~$298/mo (committed) | ~$250+/mo |
| **Failover** | 60-120 seconds | 32 seconds | ~30 seconds |
| **Read Replicas** | Up to 5 | Up to 10 | Up to 15 |
| **Storage** | 64TB max, manual | 64TB+, auto | 128TB, auto |
| **Serverless** | No | No | Aurora Serverless v2 |

**Recommendation**: Cloud SQL for GCP (simpler ops, managed PgBouncer), RDS for AWS.

---

### Serverless PostgreSQL: Neon vs Supabase

**Neon (Recommended for Eden multi-tenant)**:
- True scale-to-zero (3 compute units = ~$19/mo idle)
- Branching per org (instant clone for testing)
- Auto-suspend after 5 min inactivity
- Best for: Multi-tenant SaaS with variable usage

**Supabase**:
- $25/mo bundled with auth, storage, edge functions
- No scale-to-zero (always-on minimum)
- Better for: Apps with consistent traffic
- Includes: Auth, Storage, Edge Functions, Realtime

**PlanetScale (MySQL, not PostgreSQL)**:
- $39/mo Hobby, $99/mo Development
- Vitess-based sharding
- Branching for schema changes
- Not recommended if you need PostgreSQL

---

### Database Scaling Tiers

| Tier | Use Case | Option | Monthly Cost |
|------|----------|--------|-------------|
| **Startup** | <100 orgs, dev/test | Neon Launch | $19/mo |
| **Growth** | 100-1000 orgs | Supabase Pro or Neon Scale | $25-69/mo |
| **Scale** | 1000+ orgs, HA | Cloud SQL db-n4-standard-4 | ~$290/mo |
| **Enterprise** | 5000+ orgs, global | Aurora Serverless v2 + Read Replicas | ~$500+/mo |
| **Budget** | Proto/DEV | Railway + PostgreSQL | $25/mo |

### Connection Pooling Comparison

| Solution | Best For | Overhead | Features |
|----------|----------|----------|----------|
| **PgBouncer** | Self-hosted, transaction mode | ~5MB RAM | 3 modes, proven |
| **RDS Proxy** | AWS Lambda, IAM auth | Managed | Failover, IAM |
| **Cloud SQL Proxy** | GCP Cloud Run | Managed | Secure, auto |
| **PgCat** | High concurrency (50+ connections) | Multi-threaded | Read/write split |

**Recommendation**: Use managed pooling (RDS Proxy / Cloud SQL built-in) for serverless workloads; PgBouncer sidecar for Kubernetes.

**PgBouncer 1.21+ Transaction Mode**:
```ini
; pgbouncer.ini
[databases]
eden = host=postgres port=5432 dbname=eden

[pgbouncer]
; Transaction mode required for FastAPI/async
pool_mode = transaction
max_client_conn = 1000
default_pool_size = 20
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 3
max_db_connections = 100
max_connections = 200
server_idle_timeout = 600
server_connect_timeout = 15
server_login_retry = 3
query_wait_timeout = 30
```

**Important**: Transaction mode is incompatible with `SET` statements that persist across transactions. Use `SET LOCAL` for session-scoped settings.

**PgCat (Modern Alternative)**:
```yaml
# pgcat-config.yaml
database:
  host: postgres
  port: 5432
  user: eden
  pool_mode: transaction
  min_pool_size: 5
  max_client_conn: 1000
  servers:
    - host: 10.0.0.1
      port: 5432
      weight: 10
      name: primary
    - host: 10.0.0.2
      port: 5432
      weight: 10
      name: replica1
  sharding:
    mode: row
    key: org_id
```

PgCat advantages: multi-threaded (no GIL), read/write split, sharding support, Prometheus metrics.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Cloud Provider                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                     GKE/EKS/AKS                         │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  │    │
│  │  │  API Pods  │  │ Frontend   │  │  Sandbox     │  │    │
│  │  │  (HPA+KEDA)│  │  Pods      │  │  Node Pool   │  │    │
│  │  └─────────────┘  └─────────────┘  └──────────────┘  │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │ Cloud SQL│  │ Memory-  │  │ Artifact │  │  Cloud   │     │
│  │ Postgres │  │ store    │  │ Registry │  │  NAT     │     │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │   Qdrant Cloud  │  (or self-hosted)
                    │   (Vector DB)   │
                    └──────────────────┘
```

### Multi-Tenant Architecture

Eden uses **organization-based multi-tenancy**:

```
┌────────────────────────────────────────────────────────────┐
│                        Eden System                         │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                  Organization A                       │  │
│  │  jobs.org_id = A  (logical isolation via org_id)    │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │                  Organization B                       │  │
│  │  jobs.org_id = B  (separate row-level security)     │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                            │
│  Shared infrastructure, logical isolation via schema        │
│  Rate limiting per org via middleware                      │
│  SSO/SAML per org                                          │
│  Billing per org via Stripe                               │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

### Required Tools

```bash
# All platforms
docker>=24.0
kubectl>=1.28
terraform>=1.6

# Provider-specific CLI
aws-cli>=2.15          # AWS
google-cloud-sdk        # GCP
azure-cli              # Azure
```

### Environment Variables

```bash
# Required
export OPENROUTER_API_KEY=sk-or-...
export JWT_SECRET=$(openssl rand -hex 32)

# Provider
export PROVIDER=gcp
export REGION=us-central1
```

---

## Quick Start

### Option 1: GCP (Recommended for Production)

```bash
# 1. Initialize infrastructure
./scripts/deploy/setup.sh init --provider gcp --region us-central1

# 2. Apply terraform
cd terraform/gcp && terraform init && terraform apply

# 3. Build and deploy
./scripts/deploy/setup.sh build --provider gcp
./scripts/deploy/setup.sh deploy

# 4. Verify
./scripts/deploy/setup.sh status
```

### Option 2: Vultr (Budget Production)

```bash
# 1. Initialize
./scripts/deploy/setup.sh init --provider vultr --region newark

# 2. Apply terraform
cd terraform/vultr && terraform init && terraform apply

# 3. Deploy
./scripts/deploy/setup.sh build --provider vultr
./scripts/deploy/setup.sh deploy
```

### Option 3: Railway (Quickest Setup)

```bash
# 1. Create Railway project
railway init --project-name eden

# 2. Add PostgreSQL
railway add --database postgresql

# 3. Deploy
railway up

# 4. Configure env
railway variables set OPENROUTER_API_KEY=sk-or-...
```

### Option 4: DigitalOcean (Simple Kubernetes)

```bash
# 1. Create DOKS cluster
doctl kubernetes cluster create eden-cluster \
  --region nyc \
  --size s-4vcpu-8gb \
  --count 3

# 2. Deploy
./scripts/deploy/setup.sh init --provider digitalocean --region nyc
./scripts/deploy/setup.sh deploy
```

---

## Detailed Setup

### GCP (Recommended)

```bash
# 1. Setup
brew install google-cloud-sdk
gcloud auth login
gcloud config set project YOUR-PROJECT-ID

# 2. Enable APIs
gcloud services enable container.googleapis.com \
    compute.googleapis.com sqladmin.googleapis.com \
    redis.googleapis.com artifactregistry.googleapis.com

# 3. Terraform backend
gsutil mb gs://YOUR-BUCKET-terraform-state

# 4. Deploy
export TF_VAR_project=YOUR-PROJECT-ID
./scripts/deploy/setup.sh init --provider gcp --region us-central1
cd terraform/gcp && terraform apply

# 5. Configure kubectl
gcloud container clusters get-credentials eden-cluster --region us-central1
```

### AWS

```bash
# 1. Setup
aws configure

# 2. ECR repositories
aws ecr create-repository --repository-name eden-prod/api
aws ecr create-repository --repository-name eden-prod/frontend

# 3. Deploy
./scripts/deploy/setup.sh init --provider aws --region us-east-1
cd terraform/aws && terraform apply
aws eks update-kubeconfig --name eden-cluster --region us-east-1
```

### Azure

```bash
# 1. Setup
az login
az account set --subscription YOUR-SUBSCRIPTION

# 2. Create resource group
az group create --name eden-prod-rg --location eastus

# 3. Deploy
./scripts/deploy/setup.sh init --provider azure --region eastus
cd terraform/azure && terraform apply
az aks get-credentials --name eden-prod-aks --resource-group eden-prod-rg
```

---

## Kubernetes Scaling

### Horizontal Pod Autoscaling (HPA)

Default configuration for Eden API:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: eden-api-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: eden-api
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 50
        periodSeconds: 60
```

### Vertical Pod Autoscaler (VPA)

For right-sizing resource requests:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: eden-api-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: eden-api
  updatePolicy:
    updateMode: "Off"  # Recommendation only
```

### KEDA Event-Driven Scaling

For sandbox workers (scale-to-zero):

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sandbox-worker-scaler
spec:
  scaleTargetRef:
    name: sandbox-worker
  pollingInterval: 15
  cooldownPeriod: 300
  minReplicaCount: 0
  maxReplicaCount: 50
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus:9090
      metricName: sandbox_queue_depth
      threshold: "10"
```

### Cluster Autoscaling

**GKE Autopilot**: Automatic, no configuration needed.

**GKE Standard / EKS / AKS**:

```yaml
# GKE Cluster Autoscaler
apiVersion: autoscaling.cnrm.cloud.google.com/v1beta1
kind: ClusterController
metadata:
  name: eden-cluster-autoscaler
spec:
  location: us-central1
  autoscalingConfig:
   AutoscalingProfiles:
    - OPTIMIZE_UTILIZATION
```

---

## Database Scaling

### Cloud SQL (GCP) Configuration

```hcl
# terraform/gcp/main.tf
resource "google_sql_database_instance" "postgres" {
  name = "eden-prod-postgres"
  database_version = "POSTGRES_16"
  region = var.region

  deletion_protection = true

  settings {
    tier              = "db-n4-standard-4"
    availability_type = "REGIONAL"  # Multi-AZ
    disk_type         = "PD_SSD"
    disk_size         = 100
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
      require_ssl     = true
    }

    backup_configuration {
      enabled                        = true
      start_time                    = "03:00"
      point_in_time_recovery_enabled = true
      backup_retention_settings {
        retained_backups = 30
        retention_unit   = "COUNT"
      }
    }
  }
}
```

### Connection Pooling

For Eden's multi-tenant workload, use **transaction mode** pooling:

```yaml
# PgBouncer ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: pgbouncer-config
data:
  pgbouncer.ini: |
    [databases]
    eden = host=postgres port=5432 dbname=eden

    [pgbouncer]
    pool_mode = transaction
    max_client_conn = 1000
    default_pool_size = 20
    min_pool_size = 5
    reserve_pool_size = 5
    max_db_connections = 100
```

### Read Replicas

For analytics queries per org:

```sql
-- Create read replica for org analytics
CREATE TABLE org_analytics_replica (
    LIKE org_analytics INCLUDING ALL
) INHERITS (org_analytics);

-- Use pg_stat_activity to route queries
-- Heavy analytics to replica, transactional to primary
```

### Qdrant Scaling

| Vectors | Recommended Setup | Monthly Cost |
|---------|------------------|--------------|
| <1M | Qdrant Cloud Free (1GB) | $0 |
| 1-10M | Qdrant Cloud 16GB | ~$96 |
| 10-100M | Self-hosted on n4-standard-8 | ~$200 |
| 100M+ | Qdrant Cluster (distributed) | ~$500+ |

**Self-Hosted Qdrant on GKE**:
```yaml
# qdrant-deployment.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: qdrant
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: qdrant
        image: qdrant/qdrant:latest
        resources:
          requests:
            memory: "16Gi"
            cpu: "4"
          limits:
            memory: "32Gi"
            cpu: "8"
        volumeMounts:
        - name: qdrant-storage
          mountPath: /qdrant/storage
  volumeClaimTemplates:
  - metadata:
      name: qdrant-storage
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: "premium-rwo"
      resources:
        requests:
          storage: 100Gi
```

---

### Vector DB Comparison

| Service | Free Tier | Standard | Scale | Best For |
|---------|-----------|----------|-------|----------|
| **Qdrant Cloud** | 1GB | $96/16GB | $500/128GB | Production semantic search |
| **Pinecone** | $0 (1 index) | $70-400 | Custom | Enterprise, high dimensional |
| **Weaviate** | 1GB | $65/8GB | $500/100GB | Hybrid search (BM25 + vector) |
| **Chroma** | Local only | $0 (cloud) | $400+ | Prototyping, small scale |
| **Milvus** | Self-hosted | $200+ (cloud) | $1000+ | Large-scale, distributed |

---

## Multi-Org Scaling

### Namespace-Based Isolation

For multi-tenant Kubernetes workloads:

```yaml
# Per-org namespace with ResourceQuota
apiVersion: v1
kind: Namespace
metadata:
  name: eden-org-{org_id}
  labels:
    tenant: eden
    org_id: "{org_id}"
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: org-quota
  namespace: eden-org-{org_id}
spec:
  hard:
    requests.cpu: "4"
    requests.memory: "8Gi"
    limits.cpu: "8"
    limits.memory: "16Gi"
    pods: "50"
    services: "10"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: org-limits
  namespace: eden-org-{org_id}
spec:
  limits:
  - type: Container
    default:
      cpu: "500m"
      memory: "512Mi"
    defaultRequest:
      cpu: "100m"
      memory: "128Mi"
    max:
      cpu: "2"
      memory: "4Gi"
```

### Per-Org Rate Limiting

```python
# src/eden/api/middleware.py
from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_org_id)

async def get_org_id(request: Request) -> str:
    """Extract org_id from JWT token."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:]
        # Decode JWT, extract org_id
        return jwt.decode(token)["org_id"]
    return "anonymous"

@app.middleware("https://eden.example.com")
async def rate_limit_middleware(request: Request, call_next):
    org_id = await get_org_id(request)
    tier = await get_org_billing_tier(org_id)

    limits = {
        "free": "10/minute",
        "starter": "50/minute",
        "pro": "100/minute",
        "enterprise": "1000/minute"
    }

    # Check rate limit
    if not await check_rate_limit(org_id, limits.get(tier, "10/minute")):
        return JSONResponse(
            status_code=429,
            content={"error": "Rate limit exceeded"}
        )

    return await call_next(request)
```

### Billing Integration (Stripe)

```python
# src/eden/billing/stripe_integration.py
from stripe import Stripe
import stripe

stripe.api_key = settings.stripe_secret_key

# Create or get Stripe customer for org
async def get_or_create_stripe_customer(org: Organization) -> str:
    if org.stripe_customer_id:
        return org.stripe_customer_id

    customer = stripe.Customer.create(
        email=org.owner.email,
        name=org.name,
        metadata={"org_id": str(org.id), "plan": org.plan}
    )
    await db.orgs.update(org.id, {"stripe_customer_id": customer.id})
    return customer.id

# Create subscription
async def create_subscription(org: Organization, price_id: str):
    customer_id = await get_or_create_stripe_customer(org)

    subscription = stripe.Subscription.create(
        customer=customer_id,
        items=[{"price": price_id}],
        expand=["latest_invoice.payment_intent"],
        metadata={"org_id": str(org.id)}
    )

    await db.orgs.update(org.id, {
        "stripe_subscription_id": subscription.id,
        "subscription_status": subscription.status
    })
    return subscription

# Report AI usage to Stripe Meter
async def report_ai_usage(org_id: str, tokens_used: int, model: str):
    org = await db.orgs.get_by_id(org_id)
    if not org.stripe_subscription_id:
        return

    # Use Stripe Metered API to report usage
    stripe.billing.meters.create_event(
        event_name="ai_tokens",
        payload={
            "value": str(tokens_used),
            "identifier": f"{org_id}:{model}:{datetime.utcnow().isoformat()}"
        }
    )

# Webhook handler for billing events
async def handle_stripe_webhook(payload: bytes, sig: str):
    event = stripe.Webhook.construct_event(
        payload, sig, settings.stripe_webhook_secret
    )

    match event.type:
        case "customer.subscription.updated":
            sub = event.data.object
            await sync_subscription_status(sub)
        case "invoice.payment_succeeded":
            invoice = event.data.object
            await handle_payment_success(invoice)
        case "invoice.payment_failed":
            invoice = event.data.object
            await handle_payment_failure(invoice)
```

### Multi-Tenant Database Schema (with billing)

```sql
-- Organizations with billing
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    owner_id UUID NOT NULL REFERENCES users(id),

    -- Billing
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT DEFAULT 'trialing',
    subscription_plan TEXT DEFAULT 'free',
    current_period_end TIMESTAMPTZ,

    -- AI Credits
    ai_credits_remaining INTEGER DEFAULT 1000,
    ai_credits_reset_at TIMESTAMPTZ,

    -- Limits
    max_seats INTEGER DEFAULT 3,
    max_orgs INTEGER DEFAULT 1,
    max_jobs_per_month INTEGER DEFAULT 5,

    -- Feature flags
    features JSONB DEFAULT '{}',

    settings JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI Usage tracking
CREATE TABLE ai_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    user_id UUID NOT NULL REFERENCES users(id),

    model TEXT NOT NULL,           -- 'planner', 'critic', 'executor'
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_cents INTEGER NOT NULL,

    job_id UUID REFERENCES jobs(id),

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ai_usage_org_date ON ai_usage (org_id, created_at);
CREATE INDEX idx_ai_usage_job ON ai_usage (job_id);

-- Stripe price mappings
CREATE TABLE stripe_prices (
    id TEXT PRIMARY KEY,
    plan TEXT NOT NULL,           -- 'free', 'starter', 'pro', 'enterprise'
    ai_credits INTEGER NOT NULL,  -- monthly included credits
    price_cents INTEGER NOT NULL, -- monthly price
    stripe_price_id TEXT NOT NULL,
    is_ai_metered BOOLEAN DEFAULT false
);

-- Seed Stripe prices
INSERT INTO stripe_prices (id, plan, ai_credits, price_cents, stripe_price_id) VALUES
    ('free', 'free', 1000, 0, 'price_free'),
    ('starter', 'starter', 10000, 4900, 'price_starter'),
    ('pro', 'pro', 100000, 19900, 'price_pro'),
    ('enterprise', 'enterprise', 1000000, 79900, 'price_enterprise');
```

---

### Multi-Tenant Database Architecture

Eden uses **shared database + Row Level Security (RLS)** for multi-tenant isolation. This is the recommended approach for B2B SaaS up to ~1,000 tenants.

#### Three Isolation Models Compared

| Pattern | Isolation | Per-Tenant Cost | Operational Load | Best For |
|---------|-----------|-----------------|-----------------|----------|
| **Pooled (RLS)** | Logical, DB-enforced | Lowest | Lowest | B2B SaaS up to ~1,000 tenants |
| Schema-per-tenant | Logical, schema-scoped | Medium | High | Dozens of large enterprise tenants |
| DB-per-tenant | Physical | 10-50x higher | Highest | HIPAA, PCI, FedRAMP |

#### PostgreSQL RLS Implementation

```sql
-- 1. Create app user (non-superuser)
CREATE ROLE eden_app WITH LOGIN PASSWORD 'secure_password';
GRANT CONNECT ON DATABASE eden TO eden_app;
GRANT USAGE ON SCHEMA public TO eden_app;

-- 2. Create organizations table
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Enable RLS on business tables
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE code_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE code_references FORCE ROW LEVEL SECURITY;
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills FORCE ROW LEVEL SECURITY;

-- 4. Create RLS policies using current_setting
CREATE POLICY jobs_org_isolation ON jobs
    FOR ALL
    TO eden_app
    USING (org_id = current_setting('app.current_org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY code_refs_org_isolation ON code_references
    FOR ALL
    TO eden_app
    USING (org_id = current_setting('app.current_org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- 5. Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs TO eden_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON code_references TO eden_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON skills TO eden_app;
```

#### Application-Level Tenant Context

```python
# src/eden/db/middleware.py
from contextvars import ContextVar
from fastapi import Request, Depends
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.pool import NullPool

# Per-request tenant context
current_org_id: ContextVar[uuid.UUID | None] = ContextVar('current_org_id', default=None)

async def get_db(request: Request):
    """Dependency that sets tenant context for each request."""
    org_id = await extract_org_id_from_jwt(request)

    # Set PostgreSQL session variable (transaction-scoped)
    token = current_org_id.set(org_id)

    session = async_session_maker()
    session.execute(text("SET LOCAL app.current_org_id = :org_id"),
                   {"org_id": str(org_id)} if org_id else {"org_id": None})

    try:
        yield session
    finally:
        current_org_id.reset(token)

# Usage in route handlers
@router.get("/jobs")
async def list_jobs(db=Depends(get_db)):
    # RLS automatically filters to current_org_id
    result = await db.execute(select(Job))
    return result.scalars().all()
```

#### Escalation Path: When to Move to Schema-Per-Tenant

**Trigger conditions** (from research):
- Enterprise contract requires physical isolation (HIPAA BAAs, PCI Level 1, FedRAMP Moderate)
- Single tenant exceeds 10-20% of total database load
- Customer demands contractual data residency

**Migration approach**:
```python
# Hybrid routing - application code stays the same
async def get_tenant_db(org_id: uuid.UUID) -> AsyncSession:
    org = await db.orgs.get_by_id(org_id)

    if org.isolation_model == 'schema':
        # Route to schema-per-tenant
        schema = f"tenant_{org.slug}"
        engine = create_async_engine(
            f"postgresql+asyncpg://user:pass@host/{org.db_name}",
            connect_args={"options": f"-c search_path={schema}"}
        )
    else:
        # Route to shared RLS pool
        engine = shared_db_engine

    return async_sessionmaker(engine)()
```

---

## GitOps Deployment with ArgoCD

For multi-cluster and multi-tenant Kubernetes deployments, ArgoCD is recommended (rich UI, ApplicationSets for scale).

### ArgoCD vs Flux Comparison

| Feature | ArgoCD | Flux |
|---------|--------|------|
| **UI** | Built-in web UI | No (use Weave GitOps) |
| **Multi-tenancy** | AppProject RBAC | Namespace-based |
| **Multi-cluster** | Hub-spoke model | Per-cluster agents |
| **Image automation** | External Image Updater | Built-in |
| **Learning curve** | Moderate | Higher |

**Recommendation**: ArgoCD for Eden's multi-tenant deployment (better UI, ApplicationSets for org scaling).

### ArgoCD Installation

```bash
# Install ArgoCD (HA mode for production)
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v2.12.0/manifests/ha/install.yaml

# Or via Helm
helm repo add argo https://argoproj.github.io/argo-helm
helm install argocd argo/argo-cd --namespace argocd \
  --set server.ingress.enabled=true \
  --set server.ingress.hosts[0]=argocd.eden.example.com
```

### AppProject for Multi-Tenant Isolation

```yaml
# argocd-appproject.yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: eden-{org_id}
  namespace: argocd
spec:
  description: Eden workspace for {org_name}
  sourceRepos:
  - "https://github.com/eden-org/deployments.git"
  - "https://github.com/eden-org/apps.git"
  destinations:
  - namespace: "eden-{org_slug}"
    server: "https://kubernetes.default.svc"
  clusterResourceWhitelist:
  - group: ""
    kind: "Namespace"
  - group: ""
    kind: "ResourceQuota"
  - group: ""
    kind: "LimitRange"
  roles:
  - name: "org-admin
    description: Organization admin
    policies:
    - "p, proj:eden-{org_id}:org-admin, applications, *, {org_id}/*, allow"
```

### ApplicationSet for Auto-Provisioning Orgs

```yaml
# applicationset.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: eden-orgs
spec:
  generators:
  - matrix:
      generators:
      - git:
          repoURL: https://github.com/eden-org/orgs.git
          revision: HEAD
          directories:
          - path: orgs/*
      - cluster:
          selector:
            matchLabels:
              environment: production
  template:
    metadata:
      name: "eden-{{path.basename}}"
    spec:
      project: "eden-{{path.basename}}"
      source:
        repoURL: https://github.com/eden-org/deployments.git
        targetRevision: HEAD
        path: "apps/eden-org/base"
        kustomize:
          images:
          - ghcr.io/eden-org/api:{{path.basename}}
      destination:
        server: "{{server}}"
        namespace: "eden-{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### Eden Deployment Manifests

```yaml
# apps/eden-org/base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- namespace.yaml
- deployment.yaml
- service.yaml
- ingress.yaml
- resource-quota.yaml
- network-policy.yaml
- pdb.yaml
---
# apps/eden-org/base/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: eden-{org_slug}
  labels:
    eden/org_id: "{org_id}"
    eden/org_slug: "{org_slug}"
---
# apps/eden-org/base/resource-quota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: org-quota
  namespace: eden-{org_slug}
spec:
  hard:
    requests.cpu: "4"
    requests.memory: "8Gi"
    limits.cpu: "8"
    limits.memory: "16Gi"
    pods: "50"
    services: "10"
    jobs.storage.k8s.io/jobs: "100"
---
# apps/eden-org/base/network-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: eden-{org_slug}
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
```

### Network Policies

```yaml
# Default deny all, allow only necessary
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: eden
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-allow-ingress
  namespace: eden
spec:
  podSelector:
    matchLabels:
      app: eden-api
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: ingress-nginx
    ports:
    - protocol: TCP
      port: 8000
```

### Scaling Tiers

| Org Tier | CPU | Memory | Max Pods | Rate Limit | Price |
|----------|-----|--------|----------|------------|-------|
| Free | 1 | 2Gi | 10 | 10/min | $0 |
| Starter | 2 | 4Gi | 25 | 50/min | $49/mo |
| Pro | 4 | 8Gi | 50 | 100/min | $199/mo |
| Enterprise | 16 | 32Gi | 200 | 1000/min | $799/mo |
| Unlimited | Custom | Custom | Custom | Custom | Custom |

---

## Eden SaaS Pricing Model

Eden is a multi-tenant AI-native development platform. The recommended pricing model combines **tiered subscriptions** with **usage-based components** for AI features, reflecting the variable cost of LLM tokens and compute.

### Pricing Model Philosophy (2026 Best Practices)

Based on analysis of 521 SaaS tools:

| Model | Adoption | Best For |
|-------|----------|----------|
| **Usage-based** | 31.5% | AI/ML tools, API products |
| **Per-seat** | 29.4% | Collaboration, CRM |
| **Tiered** | 67% | Most SaaS (Good/Better/Best) |
| **Hybrid** | 61% (in ARR $50M+ companies) | AI products |

**Key insight**: 40% of $50M+ ARR companies now include usage-based revenue. For AI products, hybrid (base + metered AI) outperforms pure seat-based.

### Recommended Eden Pricing Structure

Eden should use a **hybrid tiered + usage-based** model:

```
Base Subscription (per tier) + AI Credit Overage (consumption)
```

**Base subscription covers**:
- Platform access (job queuing, workspace management, org features)
- Non-AI compute (builds, tests, static analysis)
- Team collaboration features
- API rate limits

**AI usage covers**:
- LLM token consumption (planner, critic, executor agents)
- Sandboxed code generation
- Vector search queries

### Eden Pricing Tiers

#### Free Tier (/$0/mo)
```
- Up to 3 team members
- 1,000 AI credits/month
- 5 jobs/month
- Community support
- 1 org
- Public code references (limited)
```

#### Starter Tier (/$49/mo)
```
- Up to 10 team members
- 10,000 AI credits/month
- 100 jobs/month
- Email support
- 3 orgs
- Private code references
- Basic analytics
```

#### Pro Tier (/$199/mo)
```
- Up to 50 team members
- 100,000 AI credits/month
- Unlimited jobs
- Priority support
- 10 orgs
- Advanced analytics
- SSO (SAML)
- Custom integrations
- SLA: 99.5%
```

#### Enterprise Tier (/$799/mo or custom)
```
- Unlimited team members
- 1,000,000 AI credits/month
- Unlimited jobs
- Dedicated support + CSM
- Unlimited orgs
- Custom AI model config
- On-premise deployment option
- Advanced security (SCIM, IP allowlist)
- SLA: 99.9%
- Custom contracts
```

#### Enterprise Plus (Custom)
```
- Everything in Enterprise
- Custom AI credit bundles
- Volume discounts (>1M credits)
- Multi-region deployment
- Dedicated infrastructure
- HIPAA/SOC 2 compliance
- Custom SLA + DPAs
- Pricing: $2,000-$10,000+/mo
```

### AI Credit Pricing

| Usage | Cost |
|-------|------|
| Planner tokens | $0.003/1K tokens |
| Critic tokens | $0.003/1K tokens |
| Executor tokens | $0.002/1K tokens |
| Vector search | $0.001/1K vectors |
| Sandbox compute | $0.05/job |
| Overage (per 1K credits) | $0.50 |

### Credit Bundles (Add-on)

| Bundle | Price | Equivalent |
|--------|-------|------------|
| 10K credits | $5 | $0.50/1K |
| 50K credits | $20 | $0.40/1K |
| 100K credits | $35 | $0.35/1K |
| 500K credits | $150 | $0.30/1K |

### Stripe Implementation

```python
# Eden pricing configuration
PLAN_CONFIGS = {
    "free": {
        "stripe_price_id": "price_free",
        "seats": 3,
        "ai_credits_monthly": 1000,
        "jobs_per_month": 5,
        "orgs": 1,
    },
    "starter": {
        "stripe_price_id": "price_starter",
        "seats": 10,
        "ai_credits_monthly": 10000,
        "jobs_per_month": 100,
        "orgs": 3,
        "price_monthly": 4900,  # $49.00
    },
    "pro": {
        "stripe_price_id": "price_pro",
        "seats": 50,
        "ai_credits_monthly": 100000,
        "jobs_per_month": -1,  # unlimited
        "orgs": 10,
        "price_monthly": 19900,  # $199.00
    },
    "enterprise": {
        "stripe_price_id": "price_enterprise",
        "seats": -1,  # unlimited
        "ai_credits_monthly": 1000000,
        "jobs_per_month": -1,
        "orgs": -1,
        "price_monthly": 79900,  # $799.00
    },
}

# AI credit overage pricing (Stripe Metered)
CREDIT_TIERS = [
    {"up_to": 10000, "unit_amount": 500},   # $0.50/1K (included in tier)
    {"up_to": 50000, "unit_amount": 400},    # $0.40/1K
    {"up_to": 100000, "unit_amount": 350},   # $0.35/1K
    {"up_to": 500000, "unit_amount": 300},   # $0.30/1K
    {"up_to": None, "unit_amount": 250},     # $0.25/1K (volume discount)
]
```

### Revenue Metrics Targets

| Stage | MRR Target | NRR Target | Churn Target |
|-------|-----------|------------|--------------|
| Launch | $10K | >100% | <5%/mo |
| Product-Market Fit | $50K | >110% | <3%/mo |
| Growth | $200K | >120% | <2%/mo |
| Scale | $500K+ | >130% | <1%/mo |

### Pricing Page Structure

```
┌─────────────────────────────────────────────────────────────┐
│                    Eden Pricing                             │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐   ┌──────────┐   ┌──────────┐              │
│  │  Starter │   │   Pro    │   │Enterprise │              │
│  │   $49    │   │   $199   │   │   $799   │              │
│  │  /month  │   │  /month  │   │  /month  │              │
│  ├──────────┤   ├──────────┤   ├──────────┤              │
│  │10K AI    │   │100K AI   │   │  1M AI   │              │
│  │credits   │   │ credits  │   │ credits  │              │
│  │10 users  │   │50 users  │   │Unlimited │              │
│  │3 orgs    │   │10 orgs   │   │Unlimited │              │
│  │$0/over   │   │$0.50/1K  │   │$0.30/1K  │              │
│  └──────────┘   └──────────┘   └──────────┘              │
│                                                             │
│  * All plans include: job queuing, code references,         │
│    team collaboration, analytics                            │
│  * AI credits: Planner, Critic, Executor tokens            │
└─────────────────────────────────────────────────────────────┘
```

---

### KEDA Event-Driven Scaling

For sandbox workers that should scale to zero:

```yaml
# sandbox-scaled-object.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sandbox-scaler
spec:
  scaleTargetRef:
    name: sandbox-worker
  pollingInterval: 15
  cooldownPeriod: 300
  minReplicaCount: 0
  maxReplicaCount: 100
  triggers:
  # Scale on job queue depth
  - type: prometheus
    metadata:
      serverAddress: http://prometheus:9090
      metricName: eden_job_queue_depth
      threshold: "10"
      query: sum(eden_jobs_pending{org_id="{{org_id}}"})
  # Scale on cron (maintain minimum during business hours)
  - type: cron
    metadata:
      timezone: America/New_York
      start: 0 9 * * 1-5
      end: 0 18 * * 1-5
      desiredReplicas: "5"
```

**KEDA Scalers Available** (80+):
| Scaler | Use Case |
|--------|----------|
| Prometheus | Queue depth, custom metrics |
| Cron | Business hours warm-up |
| AWS SQS | Job queue depth |
| PostgreSQL | Row count trigger |
| Redis | Cache/list length |
| Azure Queue | Azure-native jobs |
| RabbitMQ | Message queue depth |

---

## Security

### Pod Security Standards

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: eden
  labels:
    pod-security.kubernetes.io/enforce: restricted
---
# API pods
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  fsGroup: 1000
  seccompProfile:
    type: RuntimeDefault
containerSecurityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
    - ALL
```

### Secret Management

```bash
# GCP Secret Manager
kubectl create secret generic eden-secrets \
  --from-literal=OPENROUTER_API_KEY=$(gcloud secrets versions access latest --secret=eden-openrouter-api-key)

# AWS Secrets Manager
kubectl create secret generic eden-secrets \
  --from-literal=OPENROUTER_API_KEY=$(aws secretsmanager get-secret-value --secret-id eden/openrouter-api-key --query SecretString --output text)

# Azure Key Vault
kubectl create secret generic eden-secrets \
  --from-literal=OPENROUTER_API_KEY=$(az keyvault secret show --vault-name eden-kv --name openrouter-api-key --query value --output tsv)
```

### Workload Identity (GCP)

```yaml
# Bind Kubernetes SA to GCP SA
apiVersion: v1
kind: ServiceAccount
metadata:
  name: eden-api
  namespace: eden
  annotations:
    iam.gke.io/gcp-service-account: eden-api@PROJECT.iam.gserviceaccount.com
---
# GCP IAM binding
gcloud iam service-accounts add-iam-policy-binding \
  eden-api@PROJECT.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor \
  --member=serviceAccount:PROJECT.svc.id.goog[eden/eden-api]
```

---

## Monitoring

### Metrics Endpoint

The API exposes Prometheus metrics at `/metrics`:

```python
# src/eden/api/app.py
from prometheus_fastapi_instrumentator import Instrumentator

Instrumentator().instrument(app).expose(app)
```

### Key Metrics to Track

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `http_requests_total` | Total requests by org, status | Error rate > 1% |
| `eden_job_duration_seconds` | Job processing time | p95 > 5min |
| `eden_sandbox_active` | Active sandbox count | > 80% capacity |
| `db_connections_active` | DB connections | > 80% max |
| `qdrant_query_duration_seconds` | Vector search latency | p95 > 100ms |

### Grafana Dashboard Panels

```json
{
  "panels": [
    {
      "title": "Requests by Org",
      "type": "timeseries",
      "targets": [
        {
          "expr": "sum by (org_id) (rate(http_requests_total[5m]))",
          "legendFormat": "{{org_id}}"
        }
      ]
    },
    {
      "title": "Job Queue Depth",
      "type": "gauge",
      "targets": [
        {
          "expr": "eden_job_queue_depth"
        }
      ]
    },
    {
      "title": "Sandbox Utilization",
      "type": "timeseries",
      "targets": [
        {
          "expr": "eden_sandbox_active / eden_sandbox_capacity * 100",
          "legendFormat": "Utilization %"
        }
      ]
    }
  ]
}
```

### Alerting Rules

```yaml
groups:
- name: eden
  rules:
  - alert: HighErrorRate
    expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.01
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "High error rate in Eden API"

  - alert: SandboxCapacityWarning
    expr: eden_sandbox_active / eden_sandbox_capacity > 0.8
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Sandbox capacity above 80%"

  - alert: DatabaseConnectionPressure
    expr: db_connections_active / db_connections_max > 0.8
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Database connections above 80%"
```

---

## Cost Optimization

### Key Levers

| Optimization | Potential Savings | Effort |
|-------------|------------------|--------|
| GKE Autopilot (vs Standard) | 20-40% | Low |
| Spot VMs for sandbox | 60-91% | Medium |
| Committed Use Discounts | 20-30% | Low |
| HPA scale-down | 30-50% | Low |
| VPA right-sizing | 20-40% | Medium |
| Qdrant self-hosted (10M+ vectors) | 80% | High |
| Neon scale-to-zero | 50-80% vs always-on | Low |
| Vultr/DOKS free control plane | $73/mo | Low |

---

### Complete Pricing Tiers by Scale

#### Tier 1: Prototype / Solo Developer

| Component | Solution | Cost/mo |
|-----------|---------|---------|
| App Hosting | Railway Starter | $5 |
| Database | Neon Launch | $19 |
| Vector DB | Qdrant Cloud Free | $0 |
| Domain + SSL | Cloudflare (free) | $0 |
| Monitoring | Grafana Cloud Free | $0 |
| **Total** | | **$24/mo** |

#### Tier 2: Startup (10-50 orgs)

| Component | Solution | Cost/mo |
|-----------|---------|---------|
| App Hosting | Vultr VKE (2 nodes) | $50 |
| Database | Neon Scale | $69 |
| Vector DB | Qdrant Cloud 16GB | $96 |
| Redis | Vultr Managed Redis | $25 |
| LB + Ingress | Vultr Load Balancer | $10 |
| Monitoring | Grafana Cloud Pro | $0 |
| **Total** | | **~$250/mo** |

#### Tier 3: Growth (50-500 orgs)

| Component | Solution | Cost/mo |
|-----------|---------|---------|
| App Hosting | GKE Autopilot | $200-500 |
| Database | Cloud SQL db-n4-standard-4 | $290 |
| Vector DB | Qdrant Cloud 64GB | $350 |
| Redis | Memorystore 4GB HA | $120 |
| LB + NAT | Cloud NAT + LB | $50 |
| Monitoring | Grafana Cloud Pro | $0 |
| **Total** | | **$1,010-1,310/mo** |

#### Tier 4: Scale (500-5000 orgs)

| Component | Solution | Cost/mo |
|-----------|---------|---------|
| App Hosting | GKE Autopilot + Spot | $400-800 |
| Database | Cloud SQL db-n4-standard-8 HA | $580 |
| Vector DB | Qdrant Cloud 128GB | $500 |
| Redis | Memorystore 16GB HA | $280 |
| LB + NAT | Cloud NAT + LB | $80 |
| Monitoring | Grafana Cloud Pro | $0 |
| **Total** | | **$1,840-2,240/mo** |

#### Tier 5: Enterprise (5000+ orgs)

| Component | Solution | Cost/mo |
|-----------|---------|---------|
| App Hosting | GKE Autopilot + reserved | $800-2000 |
| Database | Aurora Serverless v2 + replicas | $800+ |
| Vector DB | Qdrant Cluster 256GB | $1200+ |
| Redis | Memorystore 64GB Enterprise | $800+ |
| LB + NAT | Cloud NAT + LB | $150+ |
| Monitoring | Grafana Enterprise | Custom |
| **Total** | | **$3,750+/mo** |

---

### Monthly Cost Estimates

**Small (10 orgs, moderate traffic)**:
| Component | Spec | Cost |
|-----------|------|------|
| GKE Autopilot | 2-10 pods | $80-200 |
| Cloud SQL | db-n4-standard-4 | $290 |
| Memorystore | 4GB HA | $120 |
| Qdrant Cloud | 16GB | $96 |
| NAT + LB | | $50 |
| Egress | 100GB | $8 |
| **Total** | | **$644-764/mo** |

**Medium (100 orgs)**:
| Component | Spec | Cost |
|-----------|------|------|
| GKE Autopilot | 10-50 pods | $300-800 |
| Cloud SQL | db-n4-standard-8 HA | $580 |
| Memorystore | 16GB HA | $280 |
| Qdrant Cloud | 64GB | $350 |
| NAT + LB | | $80 |
| Egress | 500GB | $40 |
| **Total** | | **$1,630-2,130/mo** |

### Reserved Capacity (Annual)

| Service | 1-Year Commitment | Savings |
|---------|-------------------|---------|
| Cloud SQL | $2,800/yr | ~20% |
| Memorystore | $1,200/yr | ~30% |
| Compute (GKE) | Pay per pod | N/A |
| Vultv Kubernetes | Pay per node | N/A |

---

### Provider Cost Comparison Matrix

| Scale | GCP Autopilot | AWS EKS | Vultr VKE | DigitalOcean | DOKS |
|-------|--------------|---------|-----------|--------------|------|
| **Dev** | $100 | $150 | $55 | $70 | $75 |
| **Startup** | $400 | $600 | $150 | $200 | $200 |
| **Growth** | $1,000 | $1,500 | $400 | $500 | $500 |
| **Scale** | $2,000 | $3,000 | $800 | $1,000 | $1,000 |

---

### Complete Infrastructure Stack Costs (By Provider)

#### Budget Option: Vultr + Neon

| Component | Spec | Monthly Cost |
|-----------|------|-------------|
| VKE (2 nodes) | 4c-8gb AMD | $40 |
| Load Balancer | Vultr LB | $10 |
| Neon Scale | 6 CU, 50GB storage | $69 |
| Qdrant Cloud | 16GB | $96 |
| Redis | Vultr Managed Redis | $25 |
| Domain + SSL | Cloudflare | $0 |
| Monitoring | Grafana Cloud Free | $0 |
| **Total** | | **~$240/mo** |

#### Mid-Tier: DigitalOcean + Neon

| Component | Spec | Monthly Cost |
|-----------|------|-------------|
| DOKS (3 nodes) | s-4vcpu-8gb | $144 |
| Load Balancer | DO LB | $12 |
| Neon Scale | 6 CU, 50GB storage | $69 |
| Qdrant Cloud | 32GB | $180 |
| Redis | DO Managed Redis | $25 |
| Object Storage | 100GB | $5 |
| Domain + SSL | Cloudflare | $0 |
| Monitoring | Grafana Cloud Free | $0 |
| **Total** | | **~$435/mo** |

#### Production: GCP Autopilot + Cloud SQL

| Component | Spec | Monthly Cost |
|-----------|------|-------------|
| GKE Autopilot | 5-20 pods | $300-600 |
| Cloud SQL | db-n4-standard-4 HA | $580 |
| Memorystore | 4GB HA | $120 |
| Qdrant Cloud | 64GB | $350 |
| Cloud NAT + LB | | $80 |
| Domain + SSL | Cloudflare | $0 |
| Monitoring | Grafana Cloud Pro | $0 |
| **Total** | | **$1,430-1,730/mo** |

#### Enterprise: Multi-Region GKE + Aurora

| Component | Spec | Monthly Cost |
|-----------|------|-------------|
| GKE Autopilot (3 regions) | 20-50 pods each | $1,500-3,000 |
| Aurora Serverless v2 | 4 ACU min + replicas | $800+ |
| Qdrant Cluster | 128GB | $500 |
| Memorystore Enterprise | 64GB | $800 |
| Global LB | Cloud Armor + LB | $200 |
| SIEM + Audit | | $300 |
| Dedicated Support | | $500 |
| **Total** | | **$4,600+/mo** |

---

### Break-Even Analysis

| Scenario | Monthly Cost | Orgs Needed @ $199/mo | Orgs Needed @ $799/mo |
|----------|-------------|------------------------|-----------------------|
| Vultr ($240/mo) | $240 | 2 Starter or 1 Pro | 1 Enterprise |
| DO ($435/mo) | $435 | 3 Starter or 2 Pro | 1 Enterprise |
| GCP ($1,500/mo) | $1,500 | 8 Starter or 8 Pro | 2 Enterprise |
| GCP ($2,000/mo) | $2,000 | 11 Starter or 10 Pro | 3 Enterprise |

**Key insight**: At 10+ paying orgs, GCP Autopilot becomes more cost-effective due to better scaling and managed services. Below 10 orgs, Vultr/DO is more economical.

---

## Troubleshooting

### Pod Won't Start

```bash
# Check status
kubectl get pods -n eden -l app=eden-api

# Logs
kubectl logs -n eden -l app=eden-api --tail=100 -f

# Describe
kubectl describe pod -n eden <pod-name>

# Common fixes:
# - ImagePullBackOff: Check image registry credentials
# - CrashLoopBackOff: Check environment variables and secrets
# - Pending: kubectl describe nodes; check resource quotas
```

### Database Connection Issues

```bash
# Test connectivity
kubectl run -it --rm debug --image=postgres:16 \
  --restart=Never -- nc -zv eden-postgres 5432

# Check PgBouncer
kubectl exec -it deploy/pgbouncer -n eden -- pgb-cli -h localhost -p 5432 -U admin

# Verify connection string
# postgresql://eden:password@<service>:5432/eden?sslmode=require
```

### Sandbox Issues (Firecracker)

```bash
# Check /dev/kvm access
kubectl exec -it <pod> -- ls -la /dev/kvm

# Verify nested virt in node
kubectl get nodes -o json | jq '.items[].status.capacity'

# Check Firecracker binary
kubectl exec -it <pod> -- firecracker --version

# Verify KVM modules
kubectl exec -it <pod> -- ls /dev/kvm/
```

### Multi-Region Deployment

For global low-latency, deploy across regions:

```hcl
# terraform/modules/multi-region/main.tf
resource "google_container_cluster" "primary" {
  name     = "eden-${var.region}"
  location = var.region
}

resource "google_container_cluster" "replica" {
  count    = length(var.secondary_regions)
  name     = "eden-${var.secondary_regions[count.index]}"
  location = var.secondary_regions[count.index]
}
```

**Regional Pod Distribution**:
| Region | Use Case | Latency |
|--------|----------|---------|
| us-central1 | Primary (US) | <50ms |
| us-east1 | East coast | <30ms |
| eu-west1 | Europe | <100ms |
| ap-southeast1 | Asia Pacific | <150ms |

**Global Load Balancing**:
```yaml
# global-lb.yaml
apiVersion: networking.gke.io/v1
kind: GatewayClass
metadata:
  name: eden-global
spec:
  controller: networking.gke.io/gateway-controller
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: eden-gateway
spec:
  gatewayClassName: eden-global
  listeners:
  - name: https
    port: 443
    protocol: HTTPS
  - name: http
    port: 80
    protocol: HTTP
  addresses:
  - type: Global
```

---

### Firecracker Sandbox Scaling

**Node Pool per Region**:
```yaml
# node-pools.yaml
apiVersion: v1
kind: NodePool
metadata:
  name: sandbox-pool
spec:
  nodeLocations:
  - us-central1-a
  - us-central1-b
  autoscaling:
    minNodeCount: 2
    maxNodeCount: 20
  management:
    autoUpgrade: true
  nodeConfig:
    machineType: c3-standard-8
    preemptible: true
    labels:
      workload-type: sandbox
    taints:
    - key: sandbox
      value: "true"
      effect: NoSchedule
```

---

### Egress Costs Comparison

Egress is often a hidden cost that dramatically affects total spend:

| Provider | First 100GB | 100GB-10TB | After 10TB |
|----------|------------|-------------|------------|
| **Vultr** | $0.01/GB | $0.01/GB | $0.005/GB |
| **DigitalOcean** | Included | $0.01/GB | $0.005/GB |
| **Linode** | 2-8TB included | $0.005/GB | $0.005/GB |
| **Civo** | Unlimited | Unlimited | Unlimited |
| **OVHcloud** | Unlimited (some plans) | $0.01/GB | $0.01/GB |
| **Hetzner** | 20TB included | $1/TB | $1/TB |
| **AWS** | $0.09/GB | $0.09/GB | $0.09/GB |
| **GCP** | $0.08/GB | $0.08/GB | $0.04/GB |
| **Azure** | $0.087/GB | $0.087/GB | $0.05/GB |

**For Eden multi-tenant deployments**: Vultr, Civo, or Hetzner offer dramatically lower egress costs. For 500GB/month egress, Vultr costs $5 vs $40 on AWS.

---

### Storage IOPS Comparison

| Provider | Min IOPS | Max IOPS | $/IOPS-month |
|----------|----------|----------|--------------|
| **Azure** | 1,000 | 400,000 | ~$0.00005 |
| **AWS gp3** | 3,000 | 16,000 | ~$0.0004 |
| **GCP** | 1,500 | 60,000 | ~$0.0001 |
| **DigitalOcean** | 1,000 | 15,000 | ~$0.0001 |
| **Vultr NVMe** | 30,000 | 90,000 | ~$0.00003 |
| **Linode** | 1,000 | 40,000 | ~$0.00005 |
| **netcup** | 99,500 | 99,500 | ~$0.00001 |
| **Infomaniak** | 1,000 | 1,000 | ~$0.001 |

**For database workloads**: Vultr NVMe or netcup offer best IOPS/price. Avoid Infomaniak for I/O-intensive databases.

---

## Sandbox Isolation: Firecracker Best Practices

For Eden's multi-tenant code execution, Firecracker microVMs provide hardware-level isolation. This section covers production deployment best practices based on AWS's official documentation.

### Runtime Comparison

| Runtime | Isolation | Startup | Memory | Best For |
|---------|-----------|---------|--------|----------|
| **runc** | Namespaces/cgroups | <1ms | Baseline | Trusted workloads |
| **gVisor** | User-space kernel | ~1s | ~100MB | Moderate trust, lower overhead |
| **Kata + Firecracker** | MicroVM (KVM) | ~125ms | ~64MB | Untrusted multi-tenant code |
| **Kata + QEMU** | MicroVM (KVM) | ~200ms | ~128MB | When Firecracker unavailable |

### Firecracker Production Checklist

From AWS's production host setup documentation:

```bash
# 1. Disable SMT (Simultaneous Multi-Threading) for tenant isolation
# SMT can enable cross-tenant side-channel attacks (Spectre, MDS)
echo "nosmt" > /etc/default/grub
update-grub
reboot

# 2. Regular kernel patching
# Firecracker relies on KVM and host kernel for isolation
# Patch in accordance with security advisories (ALAS for Amazon Linux)

# 3. Use the jailer binary for production deployments
/usr/local/bin/jailer \
  --id <sandbox_id> \
  --uid <unique_uid> \
  --gid <unique_gid> \
  --chroot-base-dir /srv/jailer \
  --exec-file /path/to/firecracker \
  --network-namespace /path/to/netns \
  --seccomp-logging-fail \
  --resource-limit # Enable cgroup limits
```

### Firecracker Kubernetes Integration

Using Kata Containers with Firecracker as VMM:

```yaml
# RuntimeClass for Firecracker sandbox
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: firecracker
handler: firecracker
---
# KataConfig to use Firecracker
apiVersion: configuration.kataops.io/v1
kind: KataConfig
metadata:
  name: firecracker-config
spec:
  runtimeClass: firecracker
  vmm: firecracker
  enable募集资金:
    - debug
---
# Pod using Firecracker isolation
apiVersion: v1
kind: Pod
metadata:
  name: sandbox-pod
spec:
  runtimeClassName: firecracker
  containers:
  - name: sandbox
    image: eden-sandbox:latest
    resources:
      limits:
        cpu: "2"
        memory: "4Gi"
    securityContext:
      readOnlyRootFilesystem: true
      allowPrivilegeEscalation: false
```

### Production Firecracker Node Configuration

```yaml
# node-config.yaml for sandbox nodes
apiVersion: v1
kind: Node
metadata:
  labels:
    node.kubernetes.io/sandbox-runtime: firecracker
spec:
  taints:
  - key: sandbox
    value: "firecracker"
    effect: NoSchedule
---
# Kubelet config for sandbox nodes
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
metadata:
  name: sandbox-kubelet
featureGates:
  RuntimeClass: true
allowedRuntimeClassNames:
- firecracker
- kata
defaultRuntimeClassName: firecracker
```

### Firecracker Security Controls

```bash
# Seccomp filters (auto-loaded by Firecracker)
# Restricts host syscalls to minimum required set
# Logs violations with --seccomp-logging-fail

# Cgroup resource limits
cgcreate -g cpu,memory:/sandbox_<id>
cgset -r cpu.shares=512 /sandbox_<id>
cgset -r memory.limit_in_bytes=4294967296 /sandbox_<id>  # 4GB

# Network isolation via namespace
ip netns add sandbox_<id>
ip link add veth0 type veth peer name veth0_host
ip link set veth0 netns sandbox_<id>
```

### Network Policies for Sandboxes

```yaml
# sandbox-network-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sandbox-egress
  namespace: eden
spec:
  podSelector:
    matchLabels:
      component: sandbox
  policyTypes:
  - Egress
  egress:
  # Allow only necessary egress
  - to:
    - namespaceSelector:
        matchLabels:
          name: eden
    ports:
    - protocol: TCP
      port: 5432  # PostgreSQL
    - protocol: TCP
      port: 6333  # Qdrant
  # Allow DNS
  - to:
    - namespaceSelector: {}
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53
  # Default deny
  - ports:
    - protocol: TCP
      port: 1-65535
    - protocol: UDP
      port: 1-65535
```

### VM Pooling for Fast Cold Starts

Firecracker cold start is ~125ms, but VM pooling reduces this further:

```python
# sandbox-pooler.py
import asyncio
from typing import Dict
import firecracker as fc

class SandboxPool:
    def __init__(self, pool_size: int = 10):
        self.pool: asyncio.Queue = asyncio.Queue()
        self.active: Dict[str, fc.Firecracker] = {}

    async def warm(self):
        """Pre-create VMs for fast acquisition."""
        for i in range(pool_size):
            vm = await self._create_vm(f"warm-{i}")
            await self.pool.put(vm)

    async def acquire(self, org_id: str) -> fc.Firecracker:
        """Get a pre-warmed VM or create new."""
        if not self.pool.empty():
            vm = await self.pool.get()
        else:
            vm = await self._create_vm(org_id)

        self.active[org_id] = vm
        return vm

    async def release(self, org_id: str):
        """Return VM to pool for reuse."""
        if org_id in self.active:
            vm = self.active.pop(org_id)
            if self.pool.qsize() < pool_size:
                await vm.reset()  # Reset to clean state
                await self.pool.put(vm)

    async def _create_vm(self, vm_id: str) -> fc.Firecracker:
        # Configure VM with minimal resources
        # Kernel: 5-10 MB minimal
        # Block device: read-only rootfs
        pass
```

### Monitoring Sandbox Activity

```yaml
# Prometheus metrics for sandbox
- name: sandbox_active_vms
  type: gauge
  description: Number of active Firecracker VMs
- name: sandbox_startup_duration_seconds
  type: histogram
  description: VM cold start time
- name: sandbox_memory_usage_bytes
  type: gauge
  description: Memory used by all sandboxes
- name: sandbox_kvmViolations_total
  type: counter
  description: KVM security violations

# Alert rules
- alert: SandboxCapacityHigh
  expr: sandbox_active_vms / sandbox_max_capacity > 0.8
  for: 5m
- alert: SandboxSecurityViolation
  expr: rate(sandbox_kvmViolations_total[5m]) > 0
  for: 1m
```

---

## Observability Stack

Recommended observability stack for multi-tenant Eden deployment:

### Metrics: Prometheus + Grafana

```yaml
# prometheus-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
    rule_files:
    - /etc/prometheus/rules/*.yml
    scrape_configs:
    - job_name: 'eden-api'
      metrics_path: /metrics
      static_configs:
      - targets: ['eden-api.eden.svc:8000']
    - job_name: 'kubernetes-nodes'
      scheme: https
      kubernetes_sd_configs:
      - role: node
      relabel_configs:
      - action: labelmap
        regex: __meta_kubernetes_node_label_(.+)
    alerting:
      alertmanagers:
      - static_configs:
        - targets: ['alertmanager:9093']
```

### Logging: Loki + Grafana

```yaml
# loki-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: loki-config
data:
  loki-config.yml: |
    schema_config:
      configs:
      - from: 2024-01-01
        store: tsdb
        object_store: filesystem
        schema: v13
        index:
          period: 24h
          prefix: index_
    storage_config:
      filesystem:
        directory: /data/loki/index
    limits_config:
      reject_old_samples: true
      reject_old_samples_max_age: 168h
    multi_tenant_manifest: true  # Per-tenant label isolation
```

### Tracing: Tempo + Grafana

```yaml
# tempo-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tempo-config
data:
  tempo.yml: |
    server:
      http_listen_port: 3100
    distributor:
      receivers:
        otlp:
          protocols:
            grpc:
            http:
    storage:
      trace:
        backend: filesystem
        filesystem:
          path: /data/tempo/traces
    compactor:
      compaction:
        block_retention: 48h
```

### Multi-Tenant Dashboards

```json
{
  "title": "Eden Org Overview",
  "uid": "eden-org-overview",
  "panels": [
    {
      "title": "Requests by Org",
      "type": "timeseries",
      "targets": [{
        "expr": "sum by (org_id) (rate(http_requests_total[5m]))",
        "legendFormat": "{{org_id}}"
      }]
    },
    {
      "title": "AI Credits Usage by Org",
      "type": "piechart",
      "targets": [{
        "expr": "sum by (org_id) (eden_ai_tokens_total)",
        "legendFormat": "{{org_id}}"
      }]
    },
    {
      "title": "Sandbox Utilization",
      "type": "gauge",
      "targets": [{
        "expr": "sandbox_active_vms / sandbox_max_capacity * 100"
      }]
    },
    {
      "title": "Database Connections by Org",
      "type": "bargauge",
      "targets": [{
        "expr": "pg_stat_activity{org_id!=\"\"}",
        "legendFormat": "{{org_id}}"
      }]
    }
  ]
}
```

### Alerting by Severity

```yaml
# alert-rules.yaml
groups:
- name: eden-critical
  rules:
  - alert: HighErrorRate
    expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.01
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "High error rate in Eden API"
      runbook: "https://docs.eden.run/runbooks/high-error-rate"

  - alert: DatabaseConnectionsExhausted
    expr: pg_stat_activity_count / pg_stat_activity_max > 0.9
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Database connections above 90%"

- name: eden-warning
  rules:
  - alert: SandboxCapacityWarning
    expr: sandbox_active_vms / sandbox_max_capacity > 0.8
    for: 10m
    labels:
      severity: warning

  - alert: AIQuotaNearingLimit
    expr: eden_ai_tokens_used / eden_ai_quota_total > 0.9
    for: 1h
    labels:
      severity: warning

  - alert: PodHighMemory
    expr: container_memory_usage_bytes / container_spec_memory_limit_bytes > 0.85
    for: 5m
    labels:
      severity: warning
```

**Sandbox Worker DaemonSet**:
```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: sandbox-manager
spec:
  selector:
    matchLabels:
      app: sandbox-manager
  template:
    spec:
      nodeSelector:
        sandbox: "true"
      tolerations:
      - key: sandbox
        value: "true"
        effect: NoSchedule
      containers:
      - name: sandbox-manager
        image: eden/sandbox-manager:latest
        securityContext:
          privileged: true
        resources:
          requests:
            cpu: "2"
            memory: "4Gi"
          limits:
            cpu: "4"
            memory: "8Gi"
        volumeMounts:
        - name: kvm
          mountPath: /dev/kvm
      volumes:
      - name: kvm
        hostPath:
          path: /dev/kvm
```

### Ingress / TLS Issues

```bash
# Check cert-manager
kubectl get pods -n cert-manager

# Check certificate status
kubectl get certificate -n eden

# Verify DNS
dig api.eden.example.com
kubectl get ingress -n eden
```

### Scaling Problems

```bash
# HPA not scaling?
kubectl get hpa -n eden
kubectl describe hpa eden-api -n eden

# Check metrics server
kubectl get apiservice v1beta1.metrics.k8s.io

# Common: metric-server not installed
# Fix: kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

---

## Deployment Recommendations by Use Case

### Solo Developer / Prototype
**Recommended**: Railway + Neon

- Fastest time to deployment
- $24/mo total cost
- No Kubernetes knowledge required
- Limitations: Limited scale, cold starts

```bash
railway init
railway add postgresql
railway up
```

### Small Team (2-10 developers)
**Recommended**: Vultr VKE + Neon Scale

- Free control plane, $150/mo
- Kubernetes for future scaling
- Scale-to-zero database
- $200/mo total

```bash
./scripts/deploy/setup.sh init --provider vultr --region sjc
./scripts/deploy/setup.sh deploy
```

### Startup (10-100 users paying)
**Recommended**: GKE Autopilot + Cloud SQL

- Pay-per-pod, no idle cost
- $500-1,000/mo
- Managed database
- Production-ready

```bash
./scripts/deploy/setup.sh init --provider gcp --region us-central1
cd terraform/gcp && terraform apply
./scripts/deploy/setup.sh deploy
```

### Growth Stage (100-1000 users)
**Recommended**: GKE Standard + Cloud SQL HA + Qdrant

- Reserved instances for cost savings
- Read replicas for analytics
- $1,500-2,500/mo
- Full observability

```bash
./scripts/deploy/setup.sh init --provider gcp --region us-central1
# Use committed use discounts in terraform
cd terraform/gcp && terraform apply -var="use_committed_instances=true"
```

### Enterprise (1000+ users)
**Recommended**: Multi-region GKE + Aurora + Qdrant Cluster

- Global distribution
- Aurora Serverless for variable load
- $5,000+/mo
- Dedicated support

---

## Appendix: Terraform Output Reference

After `terraform apply`, save these:

```bash
# GCP
terraform output cluster_endpoint
terraform output artifact_registry
terraform output postgres_connection
terraform output redis_host

# AWS
terraform output cluster_endpoint
terraform output api_ecr_uri
terraform output rds_endpoint

# Azure
terraform output aks_cluster_fqdn
terraform output container_registry
terraform output postgres_connection
```

Use outputs to configure `.env` and CI/CD pipeline.
