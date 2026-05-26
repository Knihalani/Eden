#!/bin/bash
#===============================================================================
# Eden Deployment Script
# Supports: Railway, Vultr, DigitalOcean, GCP, AWS, Azure, and more
#===============================================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROVIDER="${PROVIDER:-railway}"
REGION="${REGION:-us-east-1}"
CLUSTER_NAME="${CLUSTER_NAME:-eden-cluster}"
TIER="${TIER:-budget}"  # budget, startup, production, enterprise

# Logging
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_header() { echo -e "\n${BOLD}${CYAN}=== $1 ===${NC}\n"; }

# Usage
usage() {
    cat << 'EOF'
${BOLD}Eden Deployment Script${NC}

${BOLD}Usage:${NC} $0 [COMMAND] [OPTIONS]

${BOLD}Commands:${NC}
    init                Initialize infrastructure (creates config files)
    build              Build Docker images
    deploy             Deploy to cloud
    destroy            Tear down infrastructure
    status             Check deployment status
    logs               View logs
    scale              Scale API instances

${BOLD}Providers:${NC}
    railway            ${YELLOW}# Recommended for $20/mo startup${NC}
    render             # Alternative PaaS
    fly               # Edge deployment
    vultr             # Budget VPS with K8s ($20-40/mo nodes)
    digitalocean       # Simple K8s ($24/mo nodes)
    civo               # K3s-based K8s ($5-21/mo)
    oracle             # Free control plane, cheap nodes ($20/mo)
    gcp               # GKE Autopilot (pay-per-pod)
    aws                # EKS (expensive, $73+ control plane)
    azure             # AKS (free control plane)

${BOLD}Tiers:${NC}
    budget             ${YELLOW}# ~$20-50/mo - Railway + Neon${NC}
    startup            # ~$100-200/mo - Vultr + managed DB
    production         # ~$500-1500/mo - GCP Autopilot + Cloud SQL
    enterprise         # ~$2000+/mo - Multi-region + HA

${BOLD}Options:${NC}
    --provider PROVIDER    Cloud provider (default: railway)
    --region REGION        Region (default: us-east-1)
    --tier TIER           Deployment tier (default: budget)
    --cluster NAME        Cluster name (default: eden-cluster)

${BOLD}Examples:${NC}
    # Start for $20/mo with Railway
    $0 init --provider railway --tier budget

    # Startup tier on Vultr
    $0 init --provider vultr --region sjc --tier startup

    # Production on GCP
    $0 init --provider gcp --region us-central1 --tier production

    # Deploy after init
    $0 deploy

${BOLD}Quick Start (Budget Mode - $20/mo):${NC}
    1. Sign up at railway.app
    2. Run: $0 init --provider railway --tier budget
    3. Run: $0 deploy
    4. Set environment variables in Railway dashboard

EOF
    exit 1
}

# Check dependencies
check_dependencies() {
    local skip_docker="${1:-false}"

    log_info "Checking dependencies..."
    local missing=()
    local optional_missing=()

    # Docker/git required only for build (not for init which just generates configs)
    if [[ "$skip_docker" != "true" ]]; then
        for cmd in docker git; do
            if ! command -v $cmd &> /dev/null; then
                missing+=($cmd)
            fi
        done
    fi

    # Provider-specific
    case $PROVIDER in
        vultr|digitalocean|civo|oracle)
            if ! command -v kubectl &> /dev/null; then
                missing+=(kubectl)
            fi
            if ! command -v terraform &> /dev/null; then
                missing+=(terraform)
            fi
            ;;
        gcp)
            if ! command -v gcloud &> /dev/null; then
                optional_missing+=(gcloud)
            fi
            if ! command -v kubectl &> /dev/null; then
                missing+=(kubectl)
            fi
            if ! command -v terraform &> /dev/null; then
                missing+=(terraform)
            fi
            ;;
        aws)
            if ! command -v aws &> /dev/null; then
                optional_missing+=(aws)
            fi
            if ! command -v kubectl &> /dev/null; then
                missing+=(kubectl)
            fi
            if ! command -v terraform &> /dev/null; then
                missing+=(terraform)
            fi
            ;;
        azure)
            if ! command -v az &> /dev/null; then
                optional_missing+=(az)
            fi
            if ! command -v kubectl &> /dev/null; then
                missing+=(kubectl)
            fi
            if ! command -v terraform &> /dev/null; then
                missing+=(terraform)
            fi
            ;;
    esac

    if [ ${#missing[@]} -ne 0 ]; then
        log_error "Missing required dependencies: ${missing[*]}"
        log_info "Install them and try again"
        exit 1
    fi

    if [ ${#optional_missing[@]} -ne 0 ]; then
        log_warn "Optional CLI not found: ${optional_missing[*]} - some features may be unavailable"
    fi

    log_success "Dependencies OK"
}

# Generate random suffix
generate_suffix() {
    echo "$(openssl rand -hex 4 2>/dev/null || echo "$$")"
}

#===============================================================================
# RAILWAY (Budget - ~$20/mo)
#===============================================================================

railway_init() {
    log_header "Initializing Railway Deployment (Budget Mode)"

    local suffix=$(generate_suffix)
    local project_name="eden-${suffix:0:8}"

    mkdir -p "$SCRIPT_DIR/deploy/railway"

    cat > "$SCRIPT_DIR/deploy/railway/railway.json" << 'EOF'
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "numReplicas": 1,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
EOF

    cat > "$SCRIPT_DIR/deploy/railway/Dockerfile" << 'EOF'
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy application
COPY . /app

# Install Python dependencies
RUN pip install --no-cache-dir -e .

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Run
CMD ["uvicorn", "src.eden.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
EOF

    cat > "$SCRIPT_DIR/deploy/railway/.env.railway.example" << 'EOF'
# Eden Configuration
APP_NAME=Eden
DEBUG=false

# Database (Neon - scale-to-zero, $19/mo)
DATABASE_URL=postgresql://user:pass@host/eden?sslmode=require

# Redis (Railway $5/mo or Upstash free tier)
REDIS_URL=rediss://user:pass@host:6379

# Vector DB (Qdrant Cloud free tier - 1GB)
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=your-qdrant-key

# Authentication
JWT_SECRET=change-me-in-production-minimum-32-chars

# OpenRouter (AI)
OPENROUTER_API_KEY=sk-or-your-key

# Optional: Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
EOF

    log_success "Railway config written to $SCRIPT_DIR/deploy/railway/"
    echo ""
    log_info "${BOLD}Next Steps:${NC}"
    echo "  1. Go to https://railway.app and sign up"
    echo "  2. Create a new project"
    echo "  3. Connect your GitHub repository"
    echo "  4. Add PostgreSQL plugin (Neon recommended for scale-to-zero)"
    echo "  5. Set environment variables in Railway dashboard"
    echo "  6. Deploy!"
    echo ""
    echo "${BOLD}Estimated Cost:${NC} ~$20-30/mo"
    echo "  - Railway starter: $5/mo"
    echo "  - Neon Launch: $19/mo (or $0 free tier)"
    echo "  - Qdrant Cloud: $0 (free tier 1GB)"
}

#===============================================================================
# RENDER (Alternative PaaS)
#===============================================================================

render_init() {
    log_header "Initializing Render Deployment"

    local suffix=$(generate_suffix)

    mkdir -p "$SCRIPT_DIR/deploy/render"

    cat > "$SCRIPT_DIR/deploy/render/render.yaml" << 'EOF'
services:
  - type: web
    name: eden-api
    env: python
    buildCommand: pip install -e .
    startCommand: uvicorn src.eden.api.app:app --host 0.0.0.0 --port $PORT
    healthCheckPath: /health
    plan: starter

  - type: worker
    name: eden-worker
    env: python
    buildCommand: pip install -e .
    startCommand: python -m src.eden.worker
    plan: starter

databases:
  - name: eden-postgres
    plan: starter
    databaseName: eden
EOF

    cat > "$SCRIPT_DIR/deploy/render/.env.render.example" << 'EOF'
# Eden Configuration
APP_NAME=Eden
DEBUG=false

# Database (Render PostgreSQL)
DATABASE_URL=postgresql://user:pass@host/eden

# Redis
REDIS_URL=redis://host:6379

# Vector DB
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=your-key

# Auth
JWT_SECRET=change-me-production

# OpenRouter
OPENROUTER_API_KEY=sk-or-your-key

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
EOF

    log_success "Render config written"
    echo ""
    log_info "${BOLD}Next Steps:${NC}"
    echo "  1. Go to https://render.com and sign up"
    echo "  2. Create Blueprint from render.yaml"
    echo "  3. Add PostgreSQL database"
    echo "  4. Set environment variables"
}

#===============================================================================
# FLY.IO (Edge Deployment)
#===============================================================================

fly_init() {
    log_header "Initializing Fly.io Deployment"

    mkdir -p "$SCRIPT_DIR/deploy/fly"

    cat > "$SCRIPT_DIR/deploy/fly/Dockerfile" << 'EOF'
FROM python:3.11-slim

WORKDIR /app
COPY . /app
RUN pip install --no-cache-dir -e .

EXPOSE 8000
CMD ["uvicorn", "src.eden.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
EOF

    cat > "$SCRIPT_DIR/deploy/fly/fly.toml" << 'EOF'
app = "eden-api"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8000"

[http_service]
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0
  processes = ["app"]

[[vm]]
  memory = "512mb"
  cpu_kind = "shared"
  vms = 1
EOF

    log_success "Fly.io config written"
    echo ""
    log_info "Run: fly launch --image python:3.11-slim"
}

#===============================================================================
# VULTR (Budget K8s - ~$40/mo)
#===============================================================================

vultr_init() {
    log_header "Initializing Vultr Kubernetes Engine (VKE)"

    local suffix=$(generate_suffix)
    local cluster_name="${CLUSTER_NAME:-eden-${suffix:0:8}}"

    mkdir -p "$SCRIPT_DIR/terraform/vultr"

    cat > "$SCRIPT_DIR/terraform/vultr/main.tf" << 'EOF'
terraform {
  required_version = ">= 1.0"
  required_providers {
    vultr = {
      source  = "vultr/vultr"
      version = "~> 2.0"
    }
  }
}

provider "vultr" {
  api_key = var.vultr_api_key
}

variable "vultr_api_key" {
  description = "Vultr API key"
  sensitive   = true
}

variable "region" {
  default = "ewr"
}

locals {
  name_prefix = "eden"
}

# VKE Cluster
resource "vultr_kubernetes_cluster" "main" {
  region   = var.region
  name     = "eden-cluster"
  version  = "v1.30.0+2"

  node_pools {
    label         = "general"
    node_quantity = 1
    plan          = "vc-4-8192-us"
  }
}

# Block Storage
resource "vultr_block_storage" "main" {
  region = var.region
  label = "eden-storage"
  size_gb = 50
}

# Outputs
output "cluster_endpoint" {
  value = vultr_kubernetes_cluster.main.endpoint
}

output "cluster_id" {
  value = vultr_kubernetes_cluster.main.id
}

output "kubeconfig" {
  value     = vultr_kubernetes_cluster.main.kube_config
  sensitive = true
}

output "block_storage_id" {
  value = vultr_block_storage.main.id
}
EOF

    cat > "$SCRIPT_DIR/terraform/vultr/providers.tf" << 'EOF'
variable "vultr_api_key" {}
EOF

    cat > "$SCRIPT_DIR/terraform/vultr/.terraformrc" << 'EOF'
provider_installation {
  network_mirror {
    url = "https://terraform-mirror.vultr.com/"
  }
}
EOF

    log_success "Vultr VKE config written to $SCRIPT_DIR/terraform/vultr/"
    echo ""
    log_info "${BOLD}Next Steps:${NC}"
    echo "  1. Sign up at https://vultr.com (get $100 free credit)"
    echo "  2. Get your API key from Dashboard > API"
    echo "  3. Run:"
    echo "     export VULTR_API_KEY=your-key"
    echo "     cd $SCRIPT_DIR/terraform/vultr"
    echo "     terraform init"
    echo "     terraform apply"
    echo "  4. Configure kubectl:"
    echo "     terraform output kubeconfig > ~/.kube/config"
    echo ""
    echo "${BOLD}Estimated Cost:${NC} ~$40-60/mo"
    echo "  - VKE Control Plane: $0 (free)"
    echo "  - 1x vc-4-8192 (4GB): $24/mo"
    echo "  - Load Balancer: $10/mo"
    echo "  - Block Storage 50GB: $5/mo"
}

#===============================================================================
# DIGITALOCEAN (Simple K8s - ~$50/mo)
#===============================================================================

digitalocean_init() {
    log_header "Initializing DigitalOcean Kubernetes (DOKS)"

    local suffix=$(generate_suffix)
    local cluster_name="${CLUSTER_NAME:-eden-${suffix:0:8}}"

    mkdir -p "$SCRIPT_DIR/terraform/digitalocean"

    cat > "$SCRIPT_DIR/terraform/digitalocean/main.tf" << 'EOF'
terraform {
  required_version = ">= 1.0"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

provider "digitalocean" {
  token = var.do_token
}

variable "do_token" {
  description = "DigitalOcean API token"
  sensitive   = true
}

variable "region" {
  default = "nyc"
}

locals {
  name_prefix = "eden"
}

# DOKS Cluster
resource "digitalocean_kubernetes_cluster" "main" {
  name   = "eden-cluster"
  region = var.region
  version = "1.30.0"
  auto_upgrade = true

  node_pool {
    name       = "general"
    size       = "s-4vcpu-8gb"
    node_count = 1
    auto_scale = true
    min_nodes  = 1
    max_nodes  = 5
  }
}

# Volume (optional)
resource "digitalocean_volume" "main" {
  region = var.region
  name  = "eden-storage"
  size  = 50
}

# Outputs
output "cluster_endpoint" {
  value = digitalocean_kubernetes_cluster.main.endpoint
}

output "cluster_id" {
  value = digitalocean_kubernetes_cluster.main.id
}

output "kubeconfig" {
  value     = digitalocean_kubernetes_cluster.main.kube_config
  sensitive = true
}
EOF

    log_success "DigitalOcean config written to $SCRIPT_DIR/terraform/digitalocean/"
    echo ""
    log_info "${BOLD}Next Steps:${NC}"
    echo "  1. Sign up at https://digitalocean.com (get $200 free credit)"
    echo "  2. Create API token at Dashboard > API"
    echo "  3. Run:"
    echo "     export DO_TOKEN=your-token"
    echo "     cd $SCRIPT_DIR/terraform/digitalocean"
    echo "     terraform init"
    echo "     terraform apply"
    echo "  4. Configure kubectl:"
    echo "     doctl kubernetes cluster kubeconfig save eden-cluster"
    echo ""
    echo "${BOLD}Estimated Cost:${NC} ~$50-80/mo"
    echo "  - DOKS Control Plane: $0 (free)"
    echo "  - 1x s-4vcpu-8gb: $48/mo"
    echo "  - Load Balancer: $12/mo"
}

#===============================================================================
# CIVO (K3s-based - ~$22/mo)
#===============================================================================

civo_init() {
    log_header "Initializing Civo Kubernetes (K3s)"

    local suffix=$(generate_suffix)

    mkdir -p "$SCRIPT_DIR/terraform/civo"

    cat > "$SCRIPT_DIR/terraform/civo/main.tf" << 'EOF'
terraform {
  required_version = ">= 1.0"
  required_providers {
    civo = {
      source  = "civo/civo"
      version = "~> 1.0"
    }
  }
}

provider "civo" {
  token = var.civo_token
}

variable "civo_token" {
  description = "Civo API token"
  sensitive   = true
}

variable "region" {
  default = "LON1"
}

# K3s Cluster
resource "civokubernetes_cluster" "main" {
  name       = "eden-cluster"
  region     = var.region
  version    = "1.30.0"
  num_nodes  = 1
  size       = "Small"

  # Firewall
  firewall = "eden-firewall"
}

resource "civo_firewall" "eden-firewall" {
  name = "eden-firewall"

  # Allow HTTP/HTTPS
  rule {
    label      = "http"
    action     = "allow"
    direction  = "inbound"
    protocol   = "tcp"
    port_range = "80,443"
    cidr       = ["0.0.0.0/0"]
  }

  # Allow SSH
  rule {
    label      = "ssh"
    action     = "allow"
    direction  = "inbound"
    protocol   = "tcp"
    port_range = "22"
    cidr       = ["0.0.0.0/0"]
  }
}

# Outputs
output "cluster_endpoint" {
  value = civokubernetes_cluster.main.api_server_fqdn
}

output "kubeconfig" {
  value     = civokubernetes_cluster.main.kubeconfig
  sensitive = true
}
EOF

    log_success "Civo config written to $SCRIPT_DIR/terraform/civo/"
    echo ""
    log_info "${BOLD}Next Steps:${NC}"
    echo "  1. Sign up at https://civo.com (get $70 free credit)"
    echo "  2. Get API token from Dashboard > Security > API Key"
    echo "  3. Run:"
    echo "     export CIVO_TOKEN=your-token"
    echo "     cd $SCRIPT_DIR/terraform/civo"
    echo "     terraform init"
    echo "     terraform apply"
    echo ""
    echo "${BOLD}Estimated Cost:${NC} ~$22-45/mo"
    echo "  - Civo K3s Control Plane: $0 (free)"
    echo "  - Small instance: $5.43/mo"
    echo "  - Medium instance: $21.60/mo"
}

#===============================================================================
# ORACLE CLOUD (Always-Free - ~$20/mo)
#===============================================================================

oracle_init() {
    log_header "Initializing Oracle Cloud Infrastructure (OKE)"

    local suffix=$(generate_suffix)

    mkdir -p "$SCRIPT_DIR/terraform/oracle"

    cat > "$SCRIPT_DIR/terraform/oracle/main.tf" << 'EOF'
terraform {
  required_version = ">= 1.0"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 5.0"
    }
  }
}

provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint       = var.fingerprint
  private_key_path = var.private_key_path
  region            = var.region
}

variable "tenancy_ocid" {}
variable "user_ocid" {}
variable "fingerprint" {}
variable "private_key_path" {}
variable "region" { default = "us-ashburn-1" }

# OKE Cluster
resource "oci_containerengine_cluster" "main" {
  name           = "eden-cluster"
  compartment_id = var.tenancy_ocid
  kubernetes_version = "1.30"
  vcn_id           = oci_core_vcn.eden.id

  endpoint_config {
    is_public_ip_enabled = true
    subnet_id          = oci_core_subnet.eden.id
  }

  freeform_tags = { Managed = "Terraform" }
}

# VCN
resource "oci_core_vcn" "eden" {
  compartment_id = var.tenancy_ocid
  display_name   = "eden-vcn"
  cidr_blocks    = ["10.0.0.0/16"]
}

resource "oci_core_subnet" "eden" {
  compartment_id    = var.tenancy_ocid
  vcn_id            = oci_core_vcn.eden.id
  display_name      = "eden-subnet"
  cidr_block        = "10.0.0.0/24"
  route_table_id    = oci_core_route_table.eden.id
  security_list_ids = [oci_core_security_list.eden.id]
}

resource "oci_core_route_table" "eden" {
  compartment_id = var.tenancy_ocid
  vcn_id        = oci_core_vcn.eden.id
  display_name  = "eden-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.eden.id
  }
}

resource "oci_core_internet_gateway" "eden" {
  compartment_id = var.tenancy_ocid
  vcn_id        = oci_core_vcn.eden.id
  enabled       = true
}

resource "oci_core_security_list" "eden" {
  compartment_id = var.tenancy_ocid
  vcn_id         = oci_core_vcn.eden.id
  display_name   = "eden-security-list"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  ingress_security_rules {
    protocol = "tcp"
    source   = "0.0.0.0/0"
    tcp_options {
      min = 80
      max = 80
    }
  }

  ingress_security_rules {
    protocol = "tcp"
    source   = "0.0.0.0/0"
    tcp_options {
      min = 443
      max = 443
    }
  }
}

# Node Pool
resource "oci_containerengine_node_pool" "main" {
  cluster_id  = oci_containerengine_cluster.main.id
  compartment_id = var.tenancy_ocid
  name       = "eden-pool"

  node_shape = "VM.Standard3.Flex"
  node_shape_config {
    memory_in_gbs = 4
    ocpus        = 1
  }

  node_source_details {
    image_id    = "ocid1.image.oc1.iad.aaaaaaaavvv"
    source_type = "IMAGE"
  }

  quantity_per_subnet = 1
  subnet_ids         = [oci_core_subnet.eden.id]
}

# Outputs
output "cluster_endpoint" {
  value = oci_containerengine_cluster.main.endpoint
}

output "node_pool_id" {
  value = oci_containerengine_node_pool.main.id
}
EOF

    log_success "Oracle OKE config written to $SCRIPT_DIR/terraform/oracle/"
    echo ""
    log_info "${BOLD}Next Steps:${NC}"
    echo "  1. Sign up at https://oracle.com/cloud/free (always-free tier)"
    echo "  2. Get OCIDs from OCI Console > Identity > Users"
    echo "  3. Create API key and download private key"
    echo "  4. Run terraform with your OCI credentials"
    echo ""
    echo "${BOLD}Estimated Cost:${NC} ~$20-40/mo"
    echo "  - OKE Control Plane: $0 (always free)"
    echo "  - VM.Standard3.Flex (1OCPU, 4GB): ~$20/mo"
    echo "  - Object Storage: $0 (first 10TB free)"
}

#===============================================================================
# GCP GKE Autopilot (Production - pay-per-pod)
#===============================================================================

gcp_init() {
    log_header "Initializing GCP GKE Autopilot"

    local suffix=$(generate_suffix)

    mkdir -p "$SCRIPT_DIR/terraform/gcp"

    cat > "$SCRIPT_DIR/terraform/gcp/main.tf" << 'EOF'
terraform {
  required_version = ">= 1.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
  backend "gcs" {
    bucket = "eden-terraform-state"
    prefix = "prod"
  }
}

variable "project" {}
variable "region" { default = "us-central1" }

provider "google" {
  project = var.project
  region  = var.region
}

locals {
  name_prefix = "eden-prod"
}

# GKE Autopilot Cluster
resource "google_container_cluster" "autopilot" {
  name     = "eden-autopilot"
  location = var.region

  enable_autopilot = true

  # Private cluster
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block = "172.16.0.0/28"
  }

  # Network
  network    = google_compute_network.vpc.name
  subnetwork = google_compute_subnetwork.private.name

  ip_allocation_policy {
    cluster_ipv4_cidr_block  = "10.0.0.0/16"
    services_ipv4_cidr_block = "10.1.0.0/16"
  }

  # Workload Identity
  workload_identity_config {
    workload_pool = "${var.project}.svc.id.goog"
  }

  # Shielded nodes for security
  enable_shielded_nodes = true

  # Release channel
  release_channel {
    channel = "REGULAR"
  }
}

# VPC Network
resource "google_compute_network" "vpc" {
  name                    = "${local.name_prefix}-vpc"
  auto_create_subnetworks = false
  mtu                     = 1460
}

resource "google_compute_subnetwork" "private" {
  name                     = "${local.name_prefix}-subnet"
  network                  = google_compute_network.vpc.id
  ip_cidr_range           = "10.0.0.0/24"
  region                   = var.region

  private_ip_google_access = true

  secondary_ip_range = [
    {
      ip_cidr_range = "10.1.0.0/16"
      range_name    = "pods"
    },
    {
      ip_cidr_range = "10.2.0.0/16"
      range_name    = "services"
    }
  ]
}

# Cloud SQL (PostgreSQL)
resource "google_sql_database_instance" "postgres" {
  name     = "${local.name_prefix}-postgres"
  database_version = "POSTGRES_16"
  region   = var.region

  deletion_protection = true

  settings {
    tier              = "db-n4-standard-2"
    availability_type = "REGIONAL"
    disk_type         = "PD_SSD"
    disk_size         = 50
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
    }

    maintenance_window {
      day          = 7
      hour         = 4
    }
  }
}

resource "google_sql_database" "eden" {
  name     = "eden"
  instance = google_sql_database_instance.postgres.name
}

# Memorystore Redis
resource "google_redis_instance" "redis" {
  name           = "${local.name_prefix}-redis"
  memory_size_gb = 1
  region         = var.region
  redis_version  = "redis_7_2"

  tier        = "STANDARD_HA"
  connect_mode = "PRIVATE_SERVICE_ACCESS"

  auth_enabled = true
}

# Artifact Registry
resource "google_artifact_registry_repository" "eden" {
  location      = var.region
  repository_id = "${local.name_prefix}"
  description  = "Eden container images"
  format       = "DOCKER"
}

# Outputs
output "cluster_endpoint" {
  value = google_container_cluster.autopilot.endpoint
}

output "cluster_name" {
  value = google_container_cluster.autopilot.name
}

output "artifact_registry" {
  value = google_artifact_registry_repository.eden.repository_url
}

output "postgres_connection" {
  value       = google_sql_database_instance.postgres.connection_name
  sensitive   = true
}

output "redis_host" {
  value       = google_redis_instance.redis.host
  sensitive   = true
}
EOF

    log_success "GCP config written to $SCRIPT_DIR/terraform/gcp/"
    echo ""
    log_info "${BOLD}Next Steps:${NC}"
    echo "  1. Install Google Cloud SDK: brew install google-cloud-sdk"
    echo "  2. Authenticate: gcloud auth login"
    echo "  3. Set project: gcloud config set project YOUR-PROJECT-ID"
    echo "  4. Enable APIs:"
    echo "     gcloud services enable container.googleapis.com \\"
    echo "       compute.googleapis.com sqladmin.googleapis.com redis.googleapis.com"
    echo "  5. Create Terraform backend bucket:"
    echo "     gsutil mb gs://eden-terraform-state"
    echo "  6. Run:"
    echo "     export TF_VAR_project=YOUR-PROJECT-ID"
    echo "     cd $SCRIPT_DIR/terraform/gcp"
    echo "     terraform init"
    echo "     terraform apply"
    echo ""
    echo "${BOLD}Estimated Cost:${NC} ~$100-500/mo (pay-per-pod)"
    echo "  - GKE Autopilot: $0 control plane (free!)"
    echo "  - Pay only for pod resources requested"
    echo "  - Cloud SQL db-n4-standard-2: ~$150/mo"
    echo "  - Memorystore 1GB: ~$50/mo"
}

#===============================================================================
# AWS EKS (Expensive - avoid if budget)
#===============================================================================

aws_init() {
    log_header "Initializing AWS EKS (EXPENSIVE - consider Vultr/DO instead)"

    log_warn "AWS EKS control plane costs $73/mo + expensive nodes + RDS"
    log_warn "Consider using Vultr or DigitalOcean for 80% cost savings"

    local suffix=$(generate_suffix)

    mkdir -p "$SCRIPT_DIR/terraform/aws"

    cat > "$SCRIPT_DIR/terraform/aws/main.tf" << 'EOF'
terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  backend "s3" {
    bucket = "eden-terraform-state"
    key    = "prod/terraform.tfstate"
    region = var.region
  }
}

provider "aws" {
  region = var.region
}

variable "region" { default = "us-east-1" }

locals {
  name_prefix = "eden-prod"
  tags = {
    Project     = "eden"
    Environment = "production"
  }
}

# EKS Cluster (control plane costs $73/mo!)
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = "eden-cluster"
  cluster_version = "1.30"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  # NOTE: EKS control plane costs $0.10/hour = $73/month
  cluster_endpoint_public_access = true

  eks_managed_node_groups = {
    general = {
      name           = "general"
      instance_type  = "m7g.large"
      desired_capacity = 2
      min_size       = 1
      max_size       = 4
    }
  }
}

# VPC
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "${local.name_prefix}-vpc"
  cidr = "10.0.0.0/16"

  azs             = ["${var.region}a", "${var.region}b"]
  private_subnets  = ["10.0.1.0/24", "10.0.2.0/24"]
  public_subnets   = ["10.0.101.0/24", "10.0.102.0/24"]

  enable_nat_gateway     = true
  single_nat_gateway    = false
  enable_dns_hostnames = true
  enable_dns_support   = true
}

# RDS PostgreSQL (expensive!)
module "rds" {
  source  = "terraform-aws-modules/rds/aws"
  version = "~> 6.0"

  identifier = "${local.name_prefix}-postgres"

  engine               = "postgres"
  engine_version       = "16.3"
  family               = "postgres16"
  major_engine_version = "16"
  instance_class       = "db.r8g.large"

  allocated_storage     = 100
  max_allocated_storage = 500

  db_name  = "eden"
  username = "eden_admin"
  manage_master_user_password = true

  vpc_security_group_ids = [aws_security_group.rds.id]
  db_subnet_group_name   = module.vpc.database_subnet_group
  multi_az               = true
  deletion_protection     = true

  backup_retention_period = 30
  backup_window          = "03:00-04:00"
}

# Security Groups
resource "aws_security_group" "rds" {
  name = "${local.name_prefix}-rds"
  vpc_id = module.vpc.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.eks.id]
  }
}

resource "aws_security_group" "eks" {
  name = "${local.name_prefix}-eks"
  vpc_id = module.vpc.vpc_id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Outputs
output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "rds_endpoint" {
  value       = module.rds.db_instance_endpoint
  sensitive   = true
}
EOF

    log_success "AWS config written to $SCRIPT_DIR/terraform/aws/"
    echo ""
    log_info "${BOLD}Estimated Cost:${NC} ~$400-600/mo"
    echo "  - EKS Control Plane: $73/mo"
    echo "  - 2x m7g.large EC2: ~$110/mo"
    echo "  - RDS db.r8g.large: ~$250/mo"
    echo "  - Total: ~$433/mo before egress and other costs"
    echo ""
    echo "${BOLD}WARNING:${NC} This is 10x more expensive than Railway + Neon!"
}

#===============================================================================
# Shared Kubernetes Deployment Manifests
#===============================================================================

deploy_kubernetes() {
    log_header "Deploying to Kubernetes"

    # Create namespace
    kubectl create namespace eden --dry-run=client -o yaml | kubectl apply -f -

    # Create secrets
    kubectl create secret generic eden-secrets \
        --namespace eden \
        --from-literal=OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}" \
        --from-literal=JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32)}" \
        --from-literal=POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}" \
        --dry-run=client -o yaml | kubectl apply -f -

    # Deploy API
    kubectl apply -f - << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: eden-api
  namespace: eden
spec:
  replicas: 2
  selector:
    matchLabels:
      app: eden-api
  template:
    metadata:
      labels:
        app: eden-api
    spec:
      containers:
      - name: api
        image: eden-api:latest
        ports:
        - containerPort: 8000
        envFrom:
        - secretRef:
            name: eden-secrets
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "1Gi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 8000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 8000
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: eden-api
  namespace: eden
spec:
  selector:
    app: eden-api
  ports:
  - port: 80
    targetPort: 8000
  type: ClusterIP
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: eden-api-hpa
  namespace: eden
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: eden-api
  minReplicas: 1
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
EOF

    log_success "Kubernetes deployment complete!"
}

#===============================================================================
# Deploy (provider-agnostic)
#===============================================================================

deploy() {
    log_info "Deploying Eden..."

    case $PROVIDER in
        railway|render|fly)
            log_info "PaaS deployment - use provider dashboard or CLI"
            log_info "Push to GitHub and deploy automatically"
            ;;
        vultr|digitalocean|civo|oracle|gcp|aws|azure)
            deploy_kubernetes
            ;;
        *)
            log_error "Unknown provider: $PROVIDER"
            ;;
    esac

    log_success "Deployment initiated!"
}

#===============================================================================
# Status
#===============================================================================

check_status() {
    log_info "Checking deployment status..."

    case $PROVIDER in
        vultr|digitalocean|civo|oracle|gcp|aws|azure)
            echo ""
            echo "=== Kubernetes Pods ==="
            kubectl get pods -n eden 2>/dev/null || echo "kubectl not configured"
            echo ""
            echo "=== Services ==="
            kubectl get svc -n eden 2>/dev/null || echo "kubectl not configured"
            ;;
        *)
            log_info "Check provider dashboard for status"
            ;;
    esac
}

#===============================================================================
# Scale
#===============================================================================

scale_api() {
    local replicas="${1:-2}"
    log_info "Scaling API to $replicas replicas..."

    case $PROVIDER in
        vultr|digitalocean|civo|oracle|gcp|aws|azure)
            kubectl scale deployment eden-api -n eden --replicas=$replicas 2>/dev/null || \
                log_error "Failed to scale - check kubectl configuration"
            ;;
        *)
            log_info "Scaling not available for PaaS - use dashboard"
            ;;
    esac
}

#===============================================================================
# Destroy
#===============================================================================

destroy_infra() {
    log_warn "This will destroy all infrastructure!"
    read -p "Are you sure? Type 'yes' to confirm: " confirm

    if [ "$confirm" != "yes" ]; then
        log_info "Aborted"
        exit 0
    fi

    case $PROVIDER in
        vultr|digitalocean|civo|oracle|gcp|aws|azure)
            cd "$SCRIPT_DIR/terraform/$PROVIDER" 2>/dev/null && \
                terraform destroy || \
                log_error "Failed to destroy - check terraform configuration"
            ;;
        railway|render|fly)
            log_info "Destroy via provider dashboard"
            ;;
        *)
            log_error "Unknown provider: $PROVIDER"
            ;;
    esac
}

#===============================================================================
# Main
#===============================================================================

main() {
    # Parse command and global flags
    if [ $# -eq 0 ]; then
        usage
    fi

    COMMAND="${1:-}"
    #shift 2>/dev/null || true

    # Parse global flags
    while [[ $# -gt 0 ]]; do
        case $1 in
            --provider)
                PROVIDER="$2"
                shift 2
                ;;
            --region)
                REGION="$2"
                shift 2
                ;;
            --tier)
                TIER="$2"
                shift 2
                ;;
            --cluster)
                CLUSTER_NAME="$2"
                shift 2
                ;;
            *)
                break
                ;;
        esac
    done

    case $COMMAND in
        init)
            check_dependencies true
            case $PROVIDER in
                railway)     railway_init ;;
                render)      render_init ;;
                fly)         fly_init ;;
                vultr)       vultr_init ;;
                digitalocean) digitalocean_init ;;
                civo)        civo_init ;;
                oracle)      oracle_init ;;
                gcp)         gcp_init ;;
                aws)         aws_init ;;
                azure)
                    log_warn "Azure support not yet implemented"
                    ;;
                *) log_error "Unknown provider: $PROVIDER" ;;
            esac
            ;;
        build)
            check_dependencies
            log_info "Building images not implemented - use Docker build directly"
            ;;
        deploy)
            deploy
            ;;
        destroy)
            destroy_infra
            ;;
        status)
            check_status
            ;;
        scale)
            scale_api "${1:-2}"
            ;;
        help|--help|-h)
            usage
            ;;
        *)
            log_error "Unknown command: $COMMAND"
            usage
            ;;
    esac
}

main "$@"
