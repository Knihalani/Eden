variable "hcloud_token" {
  description = "Hetzner Cloud API token (read+write), from TF_VAR_hcloud_token; never in a file."
  type        = string
  sensitive   = true
}

variable "s3_access_key" {
  description = "Hetzner Object Storage access key (TF_VAR_s3_access_key), only with manage_bucket."
  type        = string
  sensitive   = true
  default     = ""
}

variable "s3_secret_key" {
  description = "Hetzner Object Storage secret key (TF_VAR_s3_secret_key), only with manage_bucket."
  type        = string
  sensitive   = true
  default     = ""
}

variable "location" {
  description = "hel1 (Helsinki: in stock and 15% cheaper since 2026-11-10), fsn1, nbg1, ash, hil."
  type        = string
  default     = "hel1"
}

variable "network_zone" {
  description = "eu-central for hel1/fsn1/nbg1, us-east for ash, us-west for hil."
  type        = string
  default     = "eu-central"
}

variable "node_count" {
  description = "Eden machines. 1 with router_count 0 is the single box."
  type        = number
  default     = 1
  validation {
    condition     = var.node_count >= 1 && var.node_count <= 50
    error_message = "node_count must be 1-50."
  }
}

variable "router_count" {
  description = "Cluster routers (0 for a single box; 2 for redundancy behind a load balancer)."
  type        = number
  default     = 0
}

variable "node_type" {
  description = "Server type of an Eden machine (memory sets users per box: docs/DEPLOY.md §6). Check stock."
  type        = string
  default     = "ccx23"
}

variable "router_type" {
  description = "Server type of a router (it holds no users; CPU for the hop and TLS)."
  type        = string
  default     = "cpx21"
}

variable "image" {
  type    = string
  default = "ubuntu-24.04"
}

variable "ssh_public_keys" {
  description = "Admin SSH public keys by name."
  type        = map(string)
}

variable "admin_cidr" {
  description = "Where SSH is allowed from (your office or VPN), e.g. 203.0.113.4/32."
  type        = string
}

variable "eden_git_url" {
  description = "Where machines clone Eden from (a deploy key or a public mirror)."
  type        = string
}

variable "eden_ref" {
  description = "The git tag or branch every machine builds (pin a tag in production)."
  type        = string
}

variable "manage_bucket" {
  description = "Create the shared store's bucket and its lifecycle rule here (cluster only)."
  type        = bool
  default     = false
}

variable "bucket_name" {
  type    = string
  default = "eden-frozen"
}
