-- ============================================================================
-- Migration: Create worker health and ops issues tables
-- Purpose: Support worker-alive monitoring and structured ops issue logging
-- ============================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- Status enum (pass | warning | critical | error)
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'worker_status_enum') THEN
    CREATE TYPE worker_status_enum AS ENUM ('pass', 'warning', 'critical', 'error');
  END IF;
END$$;

-- --------------------------------------------------------------------------
-- quality_workerhealth: append-only run records per worker invocation
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quality_workerhealth (
  id                BIGSERIAL PRIMARY KEY,
  env_name          TEXT        NOT NULL,
  worker_name       TEXT        NOT NULL,
  run_id            UUID        NOT NULL,
  run_ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  scheduled_for_ts  TIMESTAMPTZ,
  status            worker_status_enum NOT NULL,
  duration_ms       INTEGER,
  last_success_ts   TIMESTAMPTZ,
  last_error_ts     TIMESTAMPTZ,
  error_count       INTEGER DEFAULT 0,
  error_samples     JSONB,
  metrics           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: prevent duplicate inserts on retries/double triggers
CREATE UNIQUE INDEX IF NOT EXISTS uq_quality_workerhealth_run
  ON quality_workerhealth(env_name, worker_name, run_id);

CREATE INDEX IF NOT EXISTS idx_quality_workerhealth_run_ts
  ON quality_workerhealth(env_name, worker_name, run_ts DESC);

CREATE INDEX IF NOT EXISTS idx_quality_workerhealth_status
  ON quality_workerhealth(env_name, worker_name, status, run_ts DESC);

-- --------------------------------------------------------------------------
-- ops_issues: append-only structured ops errors/warnings
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_issues (
  id           BIGSERIAL PRIMARY KEY,
  env_name     TEXT,
  worker_name  TEXT,
  severity     worker_status_enum NOT NULL,
  event_ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
  code         TEXT,
  message      TEXT,
  context      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_issues_recent
  ON ops_issues(env_name, worker_name, event_ts DESC);

CREATE INDEX IF NOT EXISTS idx_ops_issues_severity
  ON ops_issues(env_name, worker_name, severity, event_ts DESC);

CREATE INDEX IF NOT EXISTS idx_ops_issues_code
  ON ops_issues(code, event_ts DESC);

COMMIT;
