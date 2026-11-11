# Eden on Hetzner Cloud (docs/DEPLOY.md §9): a private network, NODE_COUNT Eden machines that listen only on it,
# ROUTER_COUNT cluster routers with Caddy on 80/443, an optional load balancer over the routers, and the shared
# store as a Hetzner Object Storage bucket with a 7-day expiry. With node_count = 1 and router_count = 0 it is the
# single box (compose/single) instead.
#
# Not run or validated in the session that wrote it (no OpenTofu binary was allowed there): run `tofu init &&
# tofu validate && tofu plan` before the first apply. Hetzner dedicated (AX) servers have no Terraform provider;
# order them in the Robot console and boot them with the same cloud-init file rendered by hand.

locals {
  single       = var.node_count == 1 && var.router_count == 0
  private_cidr = "10.0.1.0/24"
  node_ips     = [for i in range(var.node_count) : cidrhost(local.private_cidr, 11 + i)]
  router_ips   = [for i in range(var.router_count) : cidrhost(local.private_cidr, 2 + i)]
  nodes_file   = join("\n", [for i, ip in local.node_ips : "n${i + 1}=http://${ip}:8790"])
}

resource "hcloud_network" "eden" {
  name     = "eden"
  ip_range = "10.0.0.0/16"
}

resource "hcloud_network_subnet" "eden" {
  network_id   = hcloud_network.eden.id
  type         = "cloud"
  network_zone = var.network_zone
  ip_range     = local.private_cidr
}

resource "hcloud_ssh_key" "admin" {
  for_each   = var.ssh_public_keys
  name       = "eden-${each.key}"
  public_key = each.value
}

# Spread the nodes over hosts: a host failure takes one node (its users fail over), not several.
resource "hcloud_placement_group" "nodes" {
  name = "eden-nodes"
  type = "spread"
}

# Public side: SSH from the admin range only; web for routers (or the single box). Private traffic is not filtered by
# Hetzner's firewall; ufw on each machine (cloud-init) keeps 8790 to the private range.
resource "hcloud_firewall" "web" {
  name = "eden-web"
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = [var.admin_cidr]
  }
  dynamic "rule" {
    for_each = ["80", "443"]
    content {
      direction  = "in"
      protocol   = "tcp"
      port       = rule.value
      source_ips = ["0.0.0.0/0", "::/0"]
    }
  }
  rule {
    direction  = "in"
    protocol   = "udp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_firewall" "node" {
  name = "eden-node"
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = [var.admin_cidr]
  }
}

resource "hcloud_server" "node" {
  count              = var.node_count
  name               = "eden-n${count.index + 1}"
  server_type        = var.node_type
  image              = var.image
  location           = var.location
  placement_group_id = hcloud_placement_group.nodes.id
  ssh_keys           = [for k in hcloud_ssh_key.admin : k.id]
  firewall_ids       = [local.single ? hcloud_firewall.web.id : hcloud_firewall.node.id]
  user_data = templatefile("${path.module}/../../cloud-init/eden.yaml.tftpl", {
    role         = local.single ? "single" : "node"
    compose_dir  = local.single ? "single" : "node"
    eden_git_url = var.eden_git_url
    eden_ref     = var.eden_ref
    admin_cidr   = var.admin_cidr
    private_cidr = local.private_cidr
  })
  network {
    network_id = hcloud_network.eden.id
    ip         = local.node_ips[count.index]
  }
  labels     = { app = "eden", role = local.single ? "single" : "node" }
  depends_on = [hcloud_network_subnet.eden]
  lifecycle {
    # A changed cloud-init must not replace a running node (its users would fail over): upgrades go through the
    # runbook (docs/DEPLOY.md §11).
    ignore_changes = [user_data, image]
  }
}

resource "hcloud_server" "router" {
  count        = var.router_count
  name         = "eden-router${count.index + 1}"
  server_type  = var.router_type
  image        = var.image
  location     = var.location
  ssh_keys     = [for k in hcloud_ssh_key.admin : k.id]
  firewall_ids = [hcloud_firewall.web.id]
  user_data = templatefile("${path.module}/../../cloud-init/eden.yaml.tftpl", {
    role         = "router"
    compose_dir  = "cluster-router"
    eden_git_url = var.eden_git_url
    eden_ref     = var.eden_ref
    admin_cidr   = var.admin_cidr
    private_cidr = local.private_cidr
  })
  network {
    network_id = hcloud_network.eden.id
    ip         = local.router_ips[count.index]
  }
  labels     = { app = "eden", role = "router" }
  depends_on = [hcloud_network_subnet.eden]
  lifecycle {
    ignore_changes = [user_data, image]
  }
}

# Two or more routers: one load balancer in front, TCP passthrough so each router's Caddy holds the certificate.
resource "hcloud_load_balancer" "eden" {
  count              = var.router_count > 1 ? 1 : 0
  name               = "eden"
  load_balancer_type = "lb11"
  location           = var.location
}

resource "hcloud_load_balancer_network" "eden" {
  count            = var.router_count > 1 ? 1 : 0
  load_balancer_id = hcloud_load_balancer.eden[0].id
  network_id       = hcloud_network.eden.id
}

resource "hcloud_load_balancer_target" "router" {
  count            = var.router_count > 1 ? var.router_count : 0
  type             = "server"
  load_balancer_id = hcloud_load_balancer.eden[0].id
  server_id        = hcloud_server.router[count.index].id
  use_private_ip   = true
  depends_on       = [hcloud_load_balancer_network.eden]
}

resource "hcloud_load_balancer_service" "tcp" {
  for_each         = var.router_count > 1 ? toset(["80", "443"]) : toset([])
  load_balancer_id = hcloud_load_balancer.eden[0].id
  protocol         = "tcp"
  listen_port      = tonumber(each.value)
  destination_port = tonumber(each.value)
  health_check {
    protocol = "tcp"
    port     = tonumber(each.value)
    interval = 10
    timeout  = 5
    retries  = 3
  }
}

# The shared store (D992): a bucket on Hetzner Object Storage (S3-compatible, no request fees) with copies expiring
# after 7 days (D428's bound; Eden sweeps too). Only for a cluster; a single box keeps its files on its own disk.
resource "aws_s3_bucket" "frozen" {
  count  = var.manage_bucket && !local.single ? 1 : 0
  bucket = var.bucket_name
}

resource "aws_s3_bucket_lifecycle_configuration" "frozen" {
  count  = var.manage_bucket && !local.single ? 1 : 0
  bucket = aws_s3_bucket.frozen[0].id
  rule {
    id     = "expire-frozen-users"
    status = "Enabled"
    filter {
      prefix = "frozen/"
    }
    expiration {
      days = 8
    }
  }
}
