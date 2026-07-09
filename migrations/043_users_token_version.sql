-- Audit 2026-07-06: the auth dep expects users.token_version and
-- users.last_seen_at (anti-fixation + idle-timeout window). They
-- were referenced in src/eden/api/deps.py and src/eden/api/routes/auth.py
-- but never added by a migration. The result: every JWT-authed request
-- failed with 401 "Invalid token payload" because the SELECT raised
-- UndefinedColumnError, was caught by the defensive try/except, and
-- then the missing-row check (row is None) fired.
--
-- Add both columns idempotently. token_version defaults to 0 so all
-- pre-existing tokens (which carry token_version=0) keep working.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
