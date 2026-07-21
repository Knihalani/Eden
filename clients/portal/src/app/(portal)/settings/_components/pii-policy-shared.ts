/** Categories mirror ``eden.data_platform.pii._DEFAULT_CATEGORIES``. */
export const PII_CATEGORIES: Array<{
  id: string;
  label: string;
  description: string;
}> = [
  { id: "email", label: "Email addresses", description: "user@example.com" },
  { id: "phone", label: "Phone numbers", description: "E.164 and US formats" },
  { id: "ssn", label: "Social Security Numbers", description: "US 9-digit SSN" },
  { id: "credit_card", label: "Credit card numbers", description: "PAN via Luhn check" },
  { id: "ipv4", label: "IPv4 addresses", description: "0.0.0.0/24 and above" },
  { id: "ipv6", label: "IPv6 addresses", description: "full + compressed forms" },
  { id: "jwt", label: "JWT tokens", description: "header.payload.signature" },
  { id: "api_key", label: "API keys", description: "service-provider prefixes" },
  {
    id: "url_with_creds",
    label: "URLs with embedded credentials",
    description: "https://user:pass@host",
  },
  {
    id: "password_field",
    label: "Password fields",
    description: "keys ending in password/secret",
  },
  { id: "aws_secret", label: "AWS secrets", description: "AKIA… / secret access keys" },
  { id: "private_key", label: "Private keys", description: "PEM / OpenSSH blocks" },
  { id: "iban", label: "IBAN", description: "international bank account numbers" },
  { id: "passport", label: "Passport numbers", description: "common passport patterns" },
];

export type PiiMode = "off" | "redact" | "fail_closed";

/** Mirrors ``PIIPolicyOut`` from ``eden.api.routes.pii_policy``. */
export interface PiiPolicy {
  policy_id: string;
  tenant_id: string;
  mode: PiiMode | string;
  enabled_categories: string[];
  disabled_categories: string[];
  fail_closed_on_credentials: boolean;
  redact_keys_extra: string[];
  effective_from: string;
  effective_until: string | null;
  created_by: string | null;
  notes: string | null;
}

export function derivePiiMode(enabled: string[], failClosed: boolean): PiiMode {
  if (failClosed) return "fail_closed";
  if (enabled.length === 0) return "off";
  return "redact";
}

export function isPiiCategoryEnabled(draft: PiiPolicy, id: string): boolean {
  if (draft.disabled_categories.includes(id)) return false;
  if (draft.enabled_categories.includes(id)) return true;
  return false;
}
