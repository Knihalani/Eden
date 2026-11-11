variable "region" {
  description = "e.g. eu-frankfurt-1, us-ashburn-1 (check A1 capacity in the region first)."
  type        = string
}

variable "compartment_id" {
  description = "The compartment's OCID (the tenancy's root for a new account)."
  type        = string
}

variable "shape" {
  description = "VM.Standard.A1.Flex (ARM, Always Free eligible) or VM.Standard.E4.Flex (x86) when A1 is short."
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "node_count" {
  type    = number
  default = 1
}

variable "router_count" {
  type    = number
  default = 0
}

variable "node_ocpus" {
  description = "2 for the Always Free allowance in 2026 (4 where an account still has 4)."
  type        = number
  default     = 2
}

variable "node_memory_gb" {
  description = "12 for the Always Free allowance in 2026 (24 where an account still has it)."
  type        = number
  default     = 12
}

variable "boot_volume_gb" {
  description = "Within the 200 GB of free block storage across instances."
  type        = number
  default     = 100
}

variable "ssh_public_keys" {
  type = list(string)
}

variable "admin_cidr" {
  type = string
}

variable "eden_git_url" {
  type = string
}

variable "eden_ref" {
  type = string
}
