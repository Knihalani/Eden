-- Migration 020: Custom RBAC roles + resource-level permissions
--
-- Closes §6.3 of the June 2026 roadmap. The pre-existing role model
-- in migration 004 is a fixed enum ('owner'/'admin'/'member'/'viewer')
-- with a hardcoded permission map in ``src/eden/api/deps.py``. This
-- migration adds:
--
--   role_definitions   — org-scoped custom roles, each with a base_role
--                        (which built-in role's permissions to inherit)
--                        and a set of additional permissions.
--   role_permissions   — many-to-many between role_definitions and
--                        permission keys (e.g. 'jobs:write').
--   role_assignments   — many-to-many between role_definitions, users,
--                        and (optionally) resources for resource-level
--                        permissions.
--
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS role_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(64) NOT NULL,
    base_role VARCHAR(16) NOT NULL CHECK (base_role IN ('owner', 'admin', 'member', 'viewer')),
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, name)
);

COMMENT ON TABLE role_definitions IS
    'Per-org custom roles. Each role inherits its base_role permissions and adds its own via role_permissions.';
COMMENT ON COLUMN role_definitions.base_role IS
    'The built-in role whose permission set this custom role starts from (owner/admin/member/viewer).';

CREATE TABLE IF NOT EXISTS role_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id UUID NOT NULL REFERENCES role_definitions(id) ON DELETE CASCADE,
    permission_key VARCHAR(64) NOT NULL,
    granted BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (role_id, permission_key)
);

COMMENT ON TABLE role_permissions IS
    'Additional permissions granted (or revoked, when granted=false) to a custom role on top of its base_role.';

CREATE INDEX IF NOT EXISTS idx_role_permissions_role
    ON role_permissions (role_id);

CREATE TABLE IF NOT EXISTS role_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role_id UUID NOT NULL REFERENCES role_definitions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource_type VARCHAR(32),  -- NULL = org-wide; 'job'/'environment' for resource-scoped
    resource_id TEXT,           -- NULL when resource_type is NULL
    granted_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE role_assignments IS
    'Assigns a user to a custom role, optionally scoped to a single resource (resource_type + resource_id).';

CREATE INDEX IF NOT EXISTS idx_role_assignments_user
    ON role_assignments (user_id);
CREATE INDEX IF NOT EXISTS idx_role_assignments_role
    ON role_assignments (role_id);
CREATE INDEX IF NOT EXISTS idx_role_assignments_resource
    ON role_assignments (resource_type, resource_id)
    WHERE resource_type IS NOT NULL;

-- Sanity check: a non-NULL resource_id requires a non-NULL resource_type.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'role_assignments_resource_consistency'
    ) THEN
        ALTER TABLE role_assignments
            ADD CONSTRAINT role_assignments_resource_consistency
            CHECK (
                (resource_type IS NULL AND resource_id IS NULL)
                OR (resource_type IS NOT NULL AND resource_id IS NOT NULL)
            );
    END IF;
END$$;

COMMIT;
