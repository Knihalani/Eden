# Eden on Oracle Cloud A1.Flex (ARM64), the fallback host (docs/DEPLOY.md §2.1, §2.2): a VCN, one subnet, a security
# list, and NODE_COUNT instances booted with the same cloud-init as every other machine. node_count = 1 with
# router_count = 0 is the single box (inside the Always Free allowance at 2 OCPU / 12 GB); otherwise the nodes are a
# cluster's and each router is a small instance of its own, as on Hetzner.
#
# Not run or validated in the session that wrote it (no OpenTofu binary was allowed there): `tofu init && tofu
# validate && tofu plan` first. A1 capacity is often short ("Out of host capacity"): retry, change availability
# domain, or set shape = "VM.Standard.E4.Flex" (x86; the image builds for both).

terraform {
  required_version = ">= 1.8"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 7.0"
    }
  }
}

# Credentials from ~/.oci/config (the CLI's), never from a file in this repository.
provider "oci" {
  region = var.region
}

locals {
  single     = var.node_count == 1 && var.router_count == 0
  vcn_cidr   = "10.0.0.0/16"
  subnet     = "10.0.1.0/24"
  node_ips   = [for i in range(var.node_count) : cidrhost(local.subnet, 11 + i)]
  router_ips = [for i in range(var.router_count) : cidrhost(local.subnet, 2 + i)]
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_id
}

data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_vcn" "eden" {
  compartment_id = var.compartment_id
  cidr_blocks    = [local.vcn_cidr]
  display_name   = "eden"
  dns_label      = "eden"
}

resource "oci_core_internet_gateway" "eden" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.eden.id
  display_name   = "eden"
}

resource "oci_core_route_table" "eden" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.eden.id
  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.eden.id
  }
}

resource "oci_core_security_list" "eden" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.eden.id
  display_name   = "eden"
  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }
  ingress_security_rules {
    source   = var.admin_cidr
    protocol = "6"
    tcp_options {
      min = 22
      max = 22
    }
  }
  # Web for the single box or the routers; ufw on each machine narrows it further by role.
  dynamic "ingress_security_rules" {
    for_each = [80, 443]
    content {
      source   = "0.0.0.0/0"
      protocol = "6"
      tcp_options {
        min = ingress_security_rules.value
        max = ingress_security_rules.value
      }
    }
  }
  # Eden's API between machines, inside the subnet only.
  ingress_security_rules {
    source   = local.subnet
    protocol = "6"
    tcp_options {
      min = 8790
      max = 8790
    }
  }
}

resource "oci_core_subnet" "eden" {
  compartment_id    = var.compartment_id
  vcn_id            = oci_core_vcn.eden.id
  cidr_block        = local.subnet
  display_name      = "eden"
  dns_label         = "nodes"
  route_table_id    = oci_core_route_table.eden.id
  security_list_ids = [oci_core_security_list.eden.id]
}

resource "oci_core_instance" "node" {
  count               = var.node_count
  compartment_id      = var.compartment_id
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[count.index % length(data.oci_identity_availability_domains.ads.availability_domains)].name
  display_name        = "eden-n${count.index + 1}"
  shape               = var.shape
  shape_config {
    ocpus         = var.node_ocpus
    memory_in_gbs = var.node_memory_gb
  }
  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_gb
  }
  create_vnic_details {
    subnet_id        = oci_core_subnet.eden.id
    assign_public_ip = true
    private_ip       = local.node_ips[count.index]
  }
  metadata = {
    ssh_authorized_keys = join("\n", var.ssh_public_keys)
    user_data = base64encode(templatefile("${path.module}/../../cloud-init/eden.yaml.tftpl", {
      role         = local.single ? "single" : "node"
      compose_dir  = local.single ? "single" : "node"
      eden_git_url = var.eden_git_url
      eden_ref     = var.eden_ref
      admin_cidr   = var.admin_cidr
      private_cidr = local.subnet
    }))
  }
  lifecycle {
    ignore_changes = [metadata, source_details]
  }
}

resource "oci_core_instance" "router" {
  count               = var.router_count
  compartment_id      = var.compartment_id
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  display_name        = "eden-router${count.index + 1}"
  shape               = var.shape
  shape_config {
    ocpus         = 1
    memory_in_gbs = 4
  }
  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.ubuntu.images[0].id
  }
  create_vnic_details {
    subnet_id        = oci_core_subnet.eden.id
    assign_public_ip = true
    private_ip       = local.router_ips[count.index]
  }
  metadata = {
    ssh_authorized_keys = join("\n", var.ssh_public_keys)
    user_data = base64encode(templatefile("${path.module}/../../cloud-init/eden.yaml.tftpl", {
      role         = "router"
      compose_dir  = "cluster-router"
      eden_git_url = var.eden_git_url
      eden_ref     = var.eden_ref
      admin_cidr   = var.admin_cidr
      private_cidr = local.subnet
    }))
  }
  lifecycle {
    ignore_changes = [metadata, source_details]
  }
}

output "public_ips" {
  value = concat(oci_core_instance.router[*].public_ip, local.single ? oci_core_instance.node[*].public_ip : [])
}

output "nodes_file" {
  value = join("\n", [for i, ip in local.node_ips : "n${i + 1}=http://${ip}:8790"])
}
