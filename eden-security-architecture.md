# Eden — Security Architecture

> **Date:** May 29, 2026  
> **Purpose:** Define the full security architecture for Eden, covering authentication, authorization, data isolation, secrets management, audit compliance, prompt injection defense, sandboxing, and supply-chain security for AI-generated code. Security is not a layer bolted on top — it is a first-class design constraint that shapes every architectural decision.

---

## Table of Contents

1. [Strategic Thesis](#1-strategic-thesis)
2. [Threat Model](#2-threat-model)
3. [Authentication & Identity](#3-authentication--identity)
4. [Authorization Architecture](#4-authorization-architecture)
5. [Data Isolation & Encryption](#5-data-isolation--encryption)
6. [Secrets Management](#6-secrets-management)
7. [Audit Logging & Compliance](#7-audit-logging--compliance)
8. [Prompt Injection & Jailbreak Defense](#8-prompt-injection--jailbreak-defense)
9. [Sandboxing & Code Execution Security](#9-sandboxing--code-execution-security)
10. [Supply Chain Security for Generated Code](#10-supply-chain-security-for-generated-code)
11. [Network Security](#11-network-security)
12. [Incident Response](#12-incident-response)
13. [Implementation Roadmap](#13-implementation-roadmap)

---

## 1. Strategic Thesis

Eden generates and executes arbitrary code on behalf of users. This makes it a **high-risk target** by design. A compromised Eden instance could be used to:

- Generate malware or backdoored environments
- Exfiltrate proprietary agent logic or training data
- Poison the global knowledge base with malicious patterns
- Escalate privileges via generated code execution

Therefore, Eden's security posture must be **defense-in-depth**, **zero-trust**, and **auditable by default**. Every component assumes the others may be compromised.

**Core Principles:**

| Principle | Enforcement |
|-----------|-------------|
| **Least Privilege** | Every agent, service, and user gets the minimum permissions needed for their current task |
| **Zero Trust** | No implicit trust between services; every request is authenticated and authorized |
| **Immutable Audit** | Every security-relevant action is logged to tamper-proof storage |
| **Fail Closed** | If authorization cannot be verified, the request is denied |
| **Defense in Depth** | Multiple independent security controls for every critical path |

---

## 2. Threat Model

### 2.1 Asset Inventory

| Asset | Sensitivity | Threat Vectors |
|-------|------------|---------------|
| Generated environment code | High | Backdoors, data exfiltration channels, insecure defaults |
| Agent traces & logs | Critical | Prompt injection, data leakage, competitive intelligence |
| User API keys | Critical | Credential theft, unauthorized access, quota draining |
| Knowledge base entries | High | Poisoning, contradiction injection, bias amplification |
| Tenant data & configs | Critical | Cross-tenant leakage, unauthorized modification |
| LLM prompts & responses | High | Membership inference, training data extraction |
| Pipeline state | Medium | Manipulation of evaluation results, bypassing checks |

### 2.2 Threat Actors

| Actor | Motivation | Capabilities |
|-------|-----------|--------------|
| External attacker | Financial gain, espionage | Standard pentesting, AI-specific attacks |
| Malicious tenant | Steal other tenants' data | Insider knowledge of Eden's APIs |
| Compromised agent | Lateral movement | Runs inside sandbox with network access |
| Supply chain attacker | Persistent backdoor | Compromises model provider or dependency |
| Curious researcher | Academic/bug bounty | Prompt injection, jailbreak attempts |

### 2.3 STRIDE Analysis (Selected)

| Component | Spoofing | Tampering | Repudiation | Info Disclosure | DoS | Elevation |
|-----------|----------|-----------|-------------|-----------------|-----|-----------|
| Auth service | ✅ High | ✅ High | ✅ High | ✅ High | ✅ Med | ✅ High |
| Sandbox runner | ✅ Med | ✅ High | ✅ Med | ✅ Critical | ✅ High | ✅ Critical |
| KB ingestion | ✅ Med | ✅ Critical | ✅ High | ✅ High | ✅ Med | ✅ Med |
| Pipeline nodes | ✅ Low | ✅ High | ✅ Med | ✅ Med | ✅ High | ✅ Med |
| API layer | ✅ High | ✅ Med | ✅ High | ✅ High | ✅ High | ✅ High |

---

## 3. Authentication & Identity

### 3.1 User Authentication

Eden supports multiple authentication flows:

**Primary: OAuth 2.0 / OIDC**
- Integration with corporate IdPs (Okta, Azure AD, Google Workspace)
- SSO via SAML 2.0 for enterprise customers
- PKCE flow for SPA/mobile clients
- Refresh token rotation with binding to device fingerprint

**Secondary: API Key Authentication**
- Scoped API keys with explicit permission grants
- Keys are **hashed** in storage (never plaintext)
- Short-lived keys (default 90 days) with automatic rotation reminders
- Key usage tracking per key ID for anomaly detection

**Tertiary: Machine Identity (Agents)**
- Agents authenticate via SPIFFE/SPIRE or short-lived JWTs
- Each agent instance gets a unique identity tied to its deployment
- Agent tokens are bound to the specific environment they operate in

### 3.2 Session Management

| Feature | Implementation |
|---------|---------------|
| Token format | JWT (RS256) with short expiry (15 min access / 7 day refresh) |
| Storage | HttpOnly, Secure, SameSite=Strict cookies for web; Bearer tokens for API |
| Revocation | Redis-backed revocation list with 5s propagation SLA |
| Concurrent sessions | Limit of 10 per user; admin can revoke all sessions |
| MFA | TOTP (authenticator apps) + WebAuthn (hardware keys) for admin roles |

### 3.3 Multi-Factor Authentication (MFA)

- **Enforced for:** Organization owners, admins, anyone with `environment:write` permission
- **Optional for:** Standard developers and read-only users
- **Supported methods:** TOTP, WebAuthn/FIDO2, backup recovery codes
- **Grace period:** 7 days after role elevation before enforcement

---

## 4. Authorization Architecture

### 4.1 Permission Model

Eden uses **Attribute-Based Access Control (ABAC)** with a fallback to **Role-Based Access Control (RBAC)** for simple cases.

**Resource Types:**
- `organization` — tenant boundary
- `environment` — generated environment
- `benchmark` — evaluation suite
- `agent_config` — agent deployment configuration
- `dataset` — evaluation dataset
- `knowledge_entry` — KB article or pattern
- `job` — pipeline execution
- `api_key` — API credential

**Actions:** `create`, `read`, `update`, `delete`, `execute`, `share`, `admin`

**Attributes:**
- User attributes: `role`, `department`, `clearance_level`, `mfa_enrolled`
- Resource attributes: `owner_org`, `classification`, `shared_with`, `created_by`
- Environmental attributes: `time_of_day`, `source_ip`, `device_trust_score`

### 4.2 Policy Engine: Open Policy Agent (OPA)

Authorization decisions are centralized through OPA (or Cerbos) running as a sidecar.

**Request Flow:**

```
Client Request → API Gateway → Extract JWT claims + Resource context
                        ↓
              Call OPA /v1/data/eden/authz/allow
                        ↓
              OPA evaluates Rego policies against:
                - User attributes from JWT
                - Resource attributes from database
                - Environmental context
                        ↓
              Decision: allow / deny + obligations (e.g., "require_mfa")
```

**Example Rego Policy:**

```rego
package eden.authz

import future.keywords.if
import future.keywords.in

default allow := false

allow if {
    input.user.role == "admin"
}

allow if {
    input.action == "read"
    input.resource.type == "environment"
    input.resource.org_id == input.user.org_id
}

allow if {
    input.action == "execute"
    input.resource.type == "benchmark"
    input.user.permissions["benchmark:execute"]
    input.environment.time_of_day >= "08:00"
    input.environment.time_of_day <= "18:00"
}
```

### 4.3 Role Definitions

| Role | Description | Key Permissions |
|------|-------------|---------------|
| **Owner** | Full control of organization | `*` on `organization:*` |
| **Admin** | Manage users, billing, security settings | `admin` on `organization`, `*` on `user` |
| **Environment Engineer** | Create and modify environments | `create,read,update,delete` on `environment`, `execute` on `benchmark` |
| **Agent Operator** | Deploy and monitor agents | `read` on `environment`, `create,read,update` on `agent_config`, `execute` on `benchmark` |
| **Analyst** | View observability data | `read` on `dataset`, `read` on `job`, `read` on `knowledge_entry` |
| **Viewer** | Read-only access | `read` on shared resources |

### 4.4 Fine-Grained Tool Permissions

Agents are authorized at the **individual tool level** using the Model Context Protocol (MCP) server pattern:

- Each tool exposed to an agent is registered with a permission requirement
- The agent's runtime context includes a capability token listing permitted tools
- Tool calls are validated against this token before execution
- Tools can declare side effects (`read_only`, `mutating`, `destructive`) with escalating authorization requirements

---

## 5. Data Isolation & Encryption

### 5.1 Tenant Isolation Model

Eden uses a **hybrid isolation model**:

| Data Category | Isolation Model | Justification |
|--------------|-----------------|---------------|
| Orchestration metadata | Shared schema + RLS | Low sensitivity, high volume, needs aggregation |
| Environment code & configs | Separate schema per tenant | Medium sensitivity, requires isolation |
| Agent traces & observability | Separate schema per tenant | High sensitivity, compliance requirements |
| Knowledge base — global | Shared with ACL | Cross-tenant value, read-only for most |
| Knowledge base — tenant | Separate schema + encryption | Proprietary patterns, competitive advantage |
| User credentials & secrets | Separate database (Vault) | Critical, highest isolation |

### 5.2 Row-Level Security (RLS)

All shared PostgreSQL tables enforce RLS:

```sql
-- Enable RLS on the jobs table
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

-- Policy: users can only see jobs from their organization
CREATE POLICY tenant_isolation ON jobs
    USING (org_id = current_setting('app.current_org_id')::UUID);

-- Application sets the tenant context per connection
SET app.current_org_id = '550e8400-e29b-41d4-a716-446655440000';
```

**Enforcement:** Application layer middleware sets the tenant context on every database connection. Connection pooling (PgBouncer) uses separate pools per tenant to prevent context leakage.

### 5.3 Encryption

**At Rest:**
- Database: AES-256 via cloud provider KMS (AWS RDS encryption, Google Cloud SQL CMEK)
- Object storage (S3): Server-side encryption with KMS-managed keys
- Backups: Encrypted with tenant-specific keys where required by contract

**In Transit:**
- TLS 1.3 mandatory for all external connections
- mTLS for internal service-to-service communication (service mesh)
- Certificate pinning for SDK clients

**Application-Layer (Envelope Encryption):**

```
Sensitive Data → Encrypt with DEK (Data Encryption Key)
                        ↓
              DEK encrypted with KEK (Key Encryption Key)
                        ↓
              KEK stored in HashiCorp Vault / Cloud KMS
                        ↓
              Ciphertext + Encrypted DEK stored in database
```

**Tenant-Specific Encryption:**
- Each tenant can opt for a dedicated KEK
- KEKs are rotated every 90 days automatically
- Old KEKs are retained (encrypted) for decryption of historical data

### 5.4 Data Residency

- Tenants are pinned to a geographic region at onboarding
- Data plane (compute, storage, embeddings) stays within the pinned region
- Control plane (auth, billing, global KB) is global but does not store tenant data
- Cross-border data transfer requires explicit opt-in with DPA (Data Processing Agreement)

---

## 6. Secrets Management

### 6.1 Vault-First Architecture

Eden uses HashiCorp Vault (or cloud-native alternatives) as the single source of truth for all secrets.

**Secret Categories:**

| Category | Examples | Rotation Frequency |
|----------|----------|-------------------|
| Infrastructure | DB passwords, TLS certs, service account keys | 90 days |
| Tenant API keys | OpenAI, Anthropic, Pinecone keys | On demand / 180 days |
| SDK tokens | Short-lived agent credentials | 1 hour |
| Encryption keys | DEKs, KEKs | 90 days (KEK), per-write (DEK) |

### 6.2 Dynamic Secrets

When an agent needs external API access:

1. Agent requests credentials via Vault's dynamic secret engine
2. Vault generates a temporary credential with minimum required scopes
3. Credential is injected into the agent's environment at runtime
4. Credential auto-expires after the TTL (default: task duration + 5 min buffer)
5. Agent never sees a long-lived secret

### 6.3 Secret Injection Patterns

**Kubernetes (Production):**
- Vault Agent Injector sidecar injects secrets as files
- Secrets never appear in environment variables or logs
- Sidecar handles renewal transparently

**Local Development:**
- `eden login` fetches a short-lived developer token
- Token stored in OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret)
- SDK reads from keychain, never from `.env` files

### 6.4 API Key Lifecycle

```
Generation → Hash + Store → Distribute (one-time) → Usage Tracking
     ↓              ↓                ↓                     ↓
  Cryptographically   Only hash in DB     QR code or      Per-key metrics:
  secure random       (bcrypt/argon2)     secure download   requests, tokens,
                                                    last_used, ip_range
                                                        ↓
                                              Auto-revocation on anomaly
```

---

## 7. Audit Logging & Compliance

### 7.1 What Gets Audited

Every action on a sensitive resource generates an audit log:

| Event | Data Captured |
|-------|--------------|
| Authentication | User ID, method, IP, user agent, success/failure, MFA used |
| Authorization decision | User, resource, action, decision, policy version |
| Environment creation | Creator, prompt, model version, output hash, approval chain |
| Code execution | Sandbox ID, code hash, execution time, egress bytes, exit code |
| KB modification | Editor, previous value hash, new value hash, reason |
| Data export | Exporter, filters, row count, destination, approval ID |
| Privilege escalation | Old role, new role, granter, justification |

### 7.2 Audit Log Architecture

```
Application → Structured Log Event (JSON)
                    ↓
            Logstash / Fluent Bit (enrichment: geo, threat intel)
                    ↓
            Kafka (durable buffer, 7-day retention)
                    ↓
            ClickHouse (hot storage, 90 days, queryable)
                    ↓
            S3 Glacier (cold storage, 7 years, immutable)
```

**Immutability Guarantees:**
- Hot storage (ClickHouse): Replicated, append-only tables
- Cold storage (S3): Object Lock in Compliance mode (WORM)
- Hash chain: Each log entry includes the hash of the previous entry

### 7.3 Compliance Mapping

| Regulation | Requirement | Eden Implementation |
|------------|-------------|---------------------|
| **GDPR** | Right to deletion | Tenant data purge API; cryptographic erasure for backups |
| **GDPR** | Data portability | Export in standardized JSON/CSV with 30-day SLA |
| **SOC 2 Type II** | Access controls | OPA-based ABAC + quarterly access reviews |
| **SOC 2 Type II** | Change management | All environment changes via versioned pipeline with approval |
| **HIPAA** | PHI protection | BAA available; dedicated tenant encryption; audit trails |
| **ISO 27001** | Risk management | Annual pentests, quarterly vulnerability scans, threat modeling |

---

## 8. Prompt Injection & Jailbreak Defense

### 8.1 Defense-in-Depth Layers

**Layer 1: Input Filtering (WAF-AI)**
- Deploy a semantic firewall before prompts reach the LLM
- Pattern matching for known jailbreak templates (DAN, Developer Mode, etc.)
- Semantic analysis using a small, fast classifier to detect adversarial intent
- Rate limiting per user/IP for suspicious patterns

**Layer 2: Instruction Hierarchy**
- System prompts are prioritized over user prompts at the model level
- User input is wrapped in delimiters with explicit "untrusted" markers
- Tool outputs are similarly marked as potentially untrusted

**Layer 3: Dual-LLM Guardrail**
- Primary LLM generates the response
- Secondary "Guardrail LLM" (smaller, heavily restricted) inspects:
  - The final output for policy violations
  - Any tool calls for unauthorized operations
  - System prompt adherence
- Guardrail can block, redact, or escalate to human review

**Layer 4: Output Filtering**
- Post-generation scan for PII leakage, code injection patterns, or malicious URLs
- DLP (Data Loss Prevention) rules for tenant-specific sensitive terms
- Output is sanitized before returning to user or storing in KB

### 8.2 Tool Call Authorization

Every tool call proposed by an agent is intercepted and validated:

```python
@tool_guardrail
async def execute_sql(query: str, db_connection):
    # 1. Parse the query
    parsed = sql_parser.parse(query)

    # 2. Check against allowed operations
    if parsed.has_delete or parsed.has_drop:
        raise UnauthorizedToolCall("Destructive operations require admin approval")

    # 3. Check against resource scope
    if parsed.tables not in agent.allowed_tables:
        raise UnauthorizedToolCall(f"Access to {parsed.tables} denied")

    # 4. Log for audit
    await audit_log.record_tool_call(agent.id, query, hash(query))

    # 5. Execute with timeout and resource limits
    return await sandbox.execute(parsed, timeout=30, max_rows=1000)
```

### 8.3 Prompt Injection Test Suite

Eden maintains an internal "Red Team" benchmark:
- 500+ known jailbreak prompts (updated monthly)
- 200+ indirect injection scenarios (via tool outputs, documents)
- Automated daily runs against all deployed models
- Regression alerts if defense success rate drops below 99.5%

---

## 9. Sandboxing & Code Execution Security

### 9.1 Sandbox Architecture

Eden uses **layered sandboxing** based on risk level:

| Tier | Technology | Use Case | Startup Time | Isolation Strength |
|------|-----------|----------|---------------|-------------------|
| **Tier 1** | gVisor (user-space kernel) | Rapid tests, safe languages | ~100ms | Strong |
| **Tier 2** | Firecracker microVM | Full environment execution | ~150ms | Very Strong |
| **Tier 3** | Kata Containers + KVM | Untrusted / adversarial code | ~300ms | Maximum |

**Selection Logic:**
- Static analysis of generated code determines tier
- Network access required → minimum Tier 2
- File system operations on shared volumes → Tier 2 or 3
- Known safe patterns (pure functions, no I/O) → Tier 1

### 9.2 Resource Constraints

Every sandbox is strictly limited:

| Resource | Limit | Action on Exceed |
|----------|-------|-----------------|
| CPU time | Configurable (default 60s) | SIGKILL |
| Memory | Configurable (default 512MB) | OOM Killer |
| Disk I/O | 10MB/s read, 5MB/s write | Throttle then SIGKILL |
| Network | Egress-only via proxy; deny by default | Drop packets |
| File system | tmpfs only; no host access | EPERM |
| Syscalls | Seccomp-bpf whitelist | SIGSYS |
| Processes | Max 10 concurrent | EAGAIN |

### 9.3 Network Egress Control

```
Sandbox → Egress Proxy (Mitmproxy/Envoy)
              ↓
        Inspect: domain whitelist, content scan, DLP rules
              ↓
        Allow / Block / Quarantine for review
```

- Default: **no internet access**
- Allowed domains: Explicitly whitelisted per environment (e.g., `api.openai.com`, `github.com`)
- All egress is logged with full payload hashes (not contents, for privacy)
- HTTPS interception is **not** performed (breaks TLS); instead, SNI inspection and certificate pinning are used

### 9.4 Container Image Security

- Base images are scanned with Trivy/Grype daily
- Only signed images (Cosign) are deployed
- No `latest` tags — all images pinned by digest
- Distroless/minimal images where possible
- Root filesystem is read-only; writable areas are tmpfs with size limits

---

## 10. Supply Chain Security for Generated Code

### 10.1 Provenance & SBOM

Every generated environment includes:

```json
{
  "provenance": {
    "environment_id": "env_abc123",
    "model": "claude-sonnet-4-20250514",
    "model_provider": "anthropic",
    "temperature": 0.2,
    "prompt_version": "env-gen-v2.3.1",
    "prompt_hash": "sha256:deadbeef...",
    "generation_timestamp": "2026-05-29T12:00:00Z",
    "pipeline_version": "eden-3.2.1",
    "archivist_review": "approved",
    "chain_of_custody": ["design", "generate", "validate", "test", "audit"]
  },
  "sbom": {
    "format": "SPDX-2.3",
    "dependencies": [
      {"name": "numpy", "version": "2.1.0", "source": "pypi", "hash": "sha256:..."},
      {"name": "gymnasium", "version": "1.0.0", "source": "pypi", "hash": "sha256:..."}
    ],
    "vulnerabilities": [
      {"cve": "CVE-2026-1234", "severity": "medium", "status": "mitigated"}
    ]
  }
}
```

### 10.2 SLSA Compliance

Eden targets **SLSA Level 3** for generated artifacts:

| SLSA Level | Requirement | Eden Implementation |
|------------|-------------|---------------------|
| Level 1 | Provenance exists | ✅ SBOM + generation metadata attached |
| Level 2 | Signed provenance | ✅ Cosign signatures on all artifacts |
| Level 3 | Reproducible builds | ✅ Same prompt + model + config = same output hash |
| Level 4 | Hermetic builds | 🎯 Roadmap: fully pinned, no network during build |

### 10.3 Dependency Verification

- All package installations are pinned to exact versions with hash verification
- Private package repositories (Artifactory/Nexus) are scanned before use
- "Hallucinated dependencies" detection: verify every declared dependency exists in the registry before installation
- Automated vulnerability scanning (Snyk, Dependabot) on generated `requirements.txt` / `package.json`

### 10.4 Code Signing

- Generated code artifacts are signed by Eden's build identity
- Signature includes the full provenance chain
- Users can verify: `eden verify env_abc123` downloads artifact + signature + provenance and validates the chain

---

## 11. Network Security

### 11.1 Perimeter Architecture

```
Internet → Cloudflare / AWS WAF (DDoS, bot detection)
               ↓
           API Gateway (Kong/AWS API GW)
               ↓
           Rate Limiting (per-tenant, per-endpoint)
               ↓
           mTLS Service Mesh (Istio/Linkerd)
               ↓
           Internal Services
```

### 11.2 Service Mesh

- All internal communication is encrypted with mTLS
- Service identities (SPIFFE IDs) are used for authn between services
- Network policies restrict which services can talk to which
- Default deny: no service can reach another unless explicitly allowed

### 11.3 DDoS Protection

- Cloudflare/AWS Shield Standard for all public endpoints
- Rate limits: 100 req/min for anonymous, 1000 req/min for authenticated, 10,000 req/min for enterprise
- CAPTCHA challenge for suspicious traffic patterns
- Automatic IP blocking for sustained abuse

---

## 12. Incident Response

### 12.1 Incident Severity

| Severity | Criteria | Response Time | Example |
|----------|----------|---------------|---------|
| **P0** | Active exploitation, data breach | 15 minutes | RCE in sandbox escape |
| **P1** | Potential breach, service unavailable | 1 hour | Auth bypass discovered |
| **P2** | Vulnerability with no known exploit | 24 hours | Outdated dependency with CVE |
| **P3** | Security hygiene | 7 days | Missing security header |

### 12.2 Response Playbook (P0)

1. **Detect** → Automated alerting (Datadog/Honeycomb) + on-call rotation
2. **Isolate** → Disable affected service, revoke compromised credentials
3. **Assess** → Determine scope of exposure, identify affected tenants
4. **Contain** → Patch vulnerability, deploy fix to all regions
5. **Notify** → Inform affected tenants within 72 hours (GDPR: 72 hours to DPA)
6. **Learn** → Post-mortem, update threat model, add regression test

### 12.3 Bug Bounty

- Public bug bounty program via HackerOne or Bugcrowd
- Scope: API, portal, sandbox escape, prompt injection
- Payouts: $500–$10,000 depending on severity
- Safe harbor: Legal protection for good-faith research

---

## 13. Implementation Roadmap

### Phase 1: Foundation (Weeks 1–4)
- [ ] Implement OAuth2/OIDC authentication
- [ ] Deploy OPA for authorization decisions
- [ ] Enable PostgreSQL RLS on all shared tables
- [ ] Integrate HashiCorp Vault for secrets
- [ ] Implement audit logging pipeline (Kafka → ClickHouse → S3)

### Phase 2: Hardening (Weeks 5–8)
- [ ] Deploy gVisor sandboxing for all code execution
- [ ] Implement prompt injection defense layers 1–2
- [ ] Add API key lifecycle management
- [ ] Implement mTLS for internal services
- [ ] Deploy DDoS protection and rate limiting

### Phase 3: Advanced (Weeks 9–12)
- [ ] Add Firecracker microVM option for high-risk code
- [ ] Deploy dual-LLM guardrail system
- [ ] Implement SBOM generation and SLSA signing
- [ ] Add data residency controls
- [ ] Launch bug bounty program

### Phase 4: Compliance (Weeks 13–16)
- [ ] SOC 2 Type II audit preparation
- [ ] GDPR data portability and deletion APIs
- [ ] HIPAA BAA offering for healthcare customers
- [ ] Quarterly penetration testing engagement
- [ ] Security whitepaper publication

---

*This document should be read alongside [`eden-multi-tenancy-billing-architecture.md`](./eden-multi-tenancy-billing-architecture.md) for tenant isolation details and [`eden-integration-dominance-architecture.md`](./eden-integration-dominance-architecture.md) for the core platform architecture.*
