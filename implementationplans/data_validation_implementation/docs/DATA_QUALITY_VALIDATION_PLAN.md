# Data Quality Validation Worker - Implementation Plan v2.0

**Status:** ✅ Production-Ready  
**Date:** January 15, 2026  
**Anchor:** `000_full_script_data_validaton.sql`

---

## Executive Summary

This implementation plan defines a **production-ready, security-hardened data quality validation system** for the DistortSignals forex data pipeline. The system continuously monitors data freshness, architectural integrity, and aggregation quality through 9 specialized validation checks orchestrated by a Cloudflare Worker.

### Key Design Principles

1. **Append-Only Architecture** - All validation results stored in time-series tables (no updates/deletes)
2. **Security Hardened** - All RPCs are `SECURITY DEFINER` with RLS policies, restricted to `service_role`
3. **Performance Bounded** - All queries have statement timeouts (5-60s) and row limits
4. **Environment Isolation** - Single Supabase project per environment (no `env_name` column filtering)
5. **START-LABELED Aggregation** - Derived bar timestamps represent window start time
6. **HARD_FAIL Gates** - Critical architecture violations block deployment/alerts

---

## System Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Cloudflare Worker (Scheduled)                    │
│                  data-quality-validation-worker                     │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             │ Invokes orchestrator RPC
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   Supabase Database (PostgreSQL)                    │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  Orchestrator: rpc_run_health_checks(env, mode, trigger)   │   │
│  │  • Executes 9 validation checks in sequence                │   │
│  │  • Persists results to quality_check_results                │   │
│  │  • Creates ops_issues for non-pass checks                   │   │
│  │  • Writes summary to quality_workerhealth                   │   │
│  └────────────────┬───────────────────────────────────────────┘   │
│                   │                                                 │
│                   │ Calls individual validation RPCs                │
│                   ▼                                                 │
│  ┌───────────────────────────────────────────────────────────┐    │
│  │  9 Validation RPCs (SECURITY DEFINER, bounded)            │    │
│  │  1. rpc_check_staleness                                    │    │
│  │  2. rpc_check_architecture_gates (HARD_FAIL)              │    │
│  │  3. rpc_check_duplicates                                   │    │
│  │  4. rpc_check_dxy_components                               │    │
│  │  5. rpc_check_aggregation_reconciliation_sample            │    │
│  │  6. rpc_check_ohlc_integrity_sample                        │    │
│  │  7. rpc_check_gap_density                                  │    │
│  │  8. rpc_check_coverage_ratios                              │    │
│  │  9. rpc_check_historical_integrity_sample                  │    │
│  └───────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────┐    │
│  │  Append-Only Tables (Time-Series)                          │    │
│  │  • quality_workerhealth  (worker run log)                  │    │
│  │  • quality_check_results (individual check results)        │    │
│  │  • ops_issues            (alert/incident feed)             │    │
│  └───────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

### Execution Modes

| Mode | Frequency | Checks Run | Use Case |
|------|-----------|------------|----------|
| **fast** | Every 5 minutes | 1,2,4,5,6 | Continuous monitoring, quick feedback |
| **full** | Every 30 minutes | All 9 checks | Comprehensive validation, detailed diagnostics |

---

## Database Schema

### Table 1: `quality_workerhealth`

**Purpose:** Append-only log of worker executions (one row per run)

```sql
CREATE TABLE public.quality_workerhealth (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  
  worker_name     text NOT NULL,                -- 'data_validation_worker'
  run_id          uuid NOT NULL,                -- unique per execution
  trigger         text NOT NULL DEFAULT 'cron',  -- 'cron' | 'manual'
  mode            text NOT NULL DEFAULT 'fast',  -- 'fast' | 'full'
  
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz NOT NULL,
  duration_ms     numeric(12,2) NOT NULL,
  
  status          text NOT NULL,                -- pass|warning|critical|HARD_FAIL|error
  checks_run      int  NOT NULL DEFAULT 0,
  issue_count     int  NOT NULL DEFAULT 0,
  
  checkpoints     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {persisted_results: true}
  metrics         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {checks_run: N, issue_count: M}
  error_detail    jsonb NOT NULL DEFAULT '{}'::jsonb   -- structured errors
);

-- Indexes
CREATE INDEX idx_quality_workerhealth_recent 
  ON public.quality_workerhealth (created_at DESC);
  
CREATE INDEX idx_quality_workerhealth_status_recent 
  ON public.quality_workerhealth (status, created_at DESC);
```

**RLS Policy:** `service_role` only

**Retention:** 90 days (manual cleanup via janitor)

---

### Table 2: `ops_issues`

**Purpose:** Append-only incident feed for alerting and drill-down

```sql
CREATE TABLE public.ops_issues (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  
  source          text NOT NULL,      -- 'data_validation_worker'
  run_id          uuid NULL,          -- links to quality_workerhealth.run_id
  severity        text NOT NULL,      -- info|warning|critical|HARD_FAIL|error
  category        text NOT NULL,      -- freshness|architecture_gate|dxy|reconciliation|etc.
  title           text NOT NULL,
  message         text NOT NULL,
  
  entity          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {canonical_symbol, timeframe, ts_utc}
  context         jsonb NOT NULL DEFAULT '{}'::jsonb   -- full check payload
);

-- Indexes
CREATE INDEX idx_ops_issues_recent 
  ON public.ops_issues (created_at DESC);
  
CREATE INDEX idx_ops_issues_severity_recent 
  ON public.ops_issues (severity, created_at DESC);
```

**RLS Policy:** `service_role` only

**Retention:** 90 days

**Usage:** 
- Alerting system queries for `severity IN ('critical', 'HARD_FAIL', 'error')`
- Dashboard displays recent issues grouped by category
- Drill-down to specific symbol/timeframe failures via `entity` JSONB

---

### Table 3: `quality_check_results`

**Purpose:** Time-series storage of each validation check result

```sql
CREATE TABLE public.quality_check_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  
  run_id          uuid NOT NULL,      -- links to orchestrator run_id
  mode            text NOT NULL,      -- 'fast' | 'full'
  
  check_category  text NOT NULL,      -- freshness|architecture_gate|duplicates|etc.
  status          text NOT NULL,      -- pass|warning|critical|HARD_FAIL|error
  execution_time_ms numeric(12,2) NOT NULL DEFAULT 0,
  issue_count     int NOT NULL DEFAULT 0,
  
  result_summary  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- aggregated metrics
  issue_details   jsonb NOT NULL DEFAULT '[]'::jsonb   -- array of specific issues
);

-- Indexes
CREATE INDEX idx_quality_results_run 
  ON public.quality_check_results (run_id, created_at DESC);
  
CREATE INDEX idx_quality_results_category_time 
  ON public.quality_check_results (check_category, created_at DESC);
  
CREATE INDEX idx_quality_results_status_time 
  ON public.quality_check_results (status, created_at DESC);
```

**RLS Policy:** `service_role` only

**Retention:** 90 days

**Usage:**
- Trend analysis (pass rate over time per check category)
- Performance monitoring (execution_time_ms trends)
- Historical comparison (issue_count deltas)

---

## Validation RPCs (Security-Hardened)

### Security Model

All RPCs follow this pattern:

```sql
CREATE OR REPLACE FUNCTION public.rpc_check_xxx(...)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER          -- Runs with function owner's privileges
SET search_path = public  -- Prevents schema injection attacks
AS $$
DECLARE
  v_started timestamptz := clock_timestamp();
BEGIN
  PERFORM set_config('statement_timeout', 'XXXXms', true);  -- Hard timeout
  
  -- Strict parameter validation
  IF p_env_name IS NULL OR p_env_name = '' THEN
    RAISE EXCEPTION 'env_name cannot be empty';
  END IF;
  
  -- Parameter bounds (prevent resource exhaustion)
  p_limit := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  
  -- Query logic (bounded, indexed)
  
  RETURN jsonb_build_object(
    'env_name', p_env_name,
    'status', v_status,
    'check_category', 'xxx',
    'issue_count', v_issue_count,
    'execution_time_ms', ...,
    'result_summary', {...},
    'issue_details', [...]
  );
  
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'env_name', p_env_name,
    'status', 'error',
    'check_category', 'xxx',
    'error_message', '...',
    'error_detail', SQLSTATE || ': ' || SQLERRM
  );
END;
$$;

-- Lock down permissions
REVOKE ALL ON FUNCTION public.rpc_check_xxx(...) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_check_xxx(...) TO service_role;
```

---

### RPC 1: `rpc_check_staleness`

**Purpose:** Detect stale data (bars not updating)

**Signature:**
```sql
rpc_check_staleness(
  p_env_name text,
  p_warning_threshold_minutes int DEFAULT 5,
  p_critical_threshold_minutes int DEFAULT 15,
  p_limit int DEFAULT 100,
  p_respect_fx_weekend boolean DEFAULT true
)
```

**Weekend Suppression:**
- When `p_respect_fx_weekend=true` (default), checks are skipped on Saturday/Sunday UTC
- Forex markets are mostly 24/5; weekend checks generate false positives
- Can be disabled by passing `false` for testing or crypto/24/7 feeds
- Example: `SELECT rpc_check_staleness('production', 5, 15, 100, false)`

**Logic:**
1. If `p_respect_fx_weekend=true` AND today is Saturday/Sunday UTC → return early with `'pass'`
2. Find latest bar per `(canonical_symbol, timeframe)` using `DISTINCT ON` (fast, indexed)
3. Calculate staleness: `now() - latest_bar_ts` in minutes
4. Classify: `warning` if > 5m, `critical` if > 15m

**Performance:**
- **Timeout:** 5 seconds
- **Index:** `idx_data_bars_sym_tf_ts` on `(canonical_symbol, timeframe, ts_utc DESC)`
- **Tables:** `data_bars`, `derived_data_bars`

**Output Example:**
```json
{
  "env_name": "production",
  "status": "warning",
  "check_category": "freshness",
  "issue_count": 3,
  "execution_time_ms": 247.35,
  "result_summary": {
    "total_symbol_timeframe_pairs_checked": 45,
    "pairs_with_warning_staleness": 3,
    "pairs_with_critical_staleness": 0,
    "max_staleness_minutes": 7.2,
    "avg_staleness_minutes": 2.1
  },
  "issue_details": [
    {
      "canonical_symbol": "EURUSD",
      "timeframe": "1h",
      "table_name": "derived_data_bars",
      "latest_bar_ts": "2026-01-15T02:45:00Z",
      "staleness_minutes": 7.2,
      "severity": "warning"
    }
  ]
}
```

---

### RPC 2: `rpc_check_architecture_gates` ⚠️ HARD_FAIL

**Purpose:** Enforce critical architecture invariants

**Signature:**
```sql
rpc_check_architecture_gates(
  p_env_name text,
  p_active_lookback_minutes int DEFAULT 120,
  p_5m_recency_minutes int DEFAULT 30,
  p_1h_recency_minutes int DEFAULT 360,
  p_limit int DEFAULT 100
)
```

**Gates:**

**Gate A:** `derived_data_bars` MUST NOT contain `timeframe='1m'`  
- **Rationale:** 1m bars belong in `data_bars` only (source of truth)
- **Violation:** HARD_FAIL (breaks aggregation pipeline assumptions)

**Gate B:** Active symbols (1m bars within last 2h) MUST have recent derived bars:
- 5m bars within last 30 minutes
- 1h bars within last 6 hours
- **Violation:** HARD_FAIL (aggregator stalled/broken)

**Performance:**
- **Timeout:** 5 seconds
- **Index:** `idx_data_bars_sym_tf_ts`, `idx_derived_sym_tf_ts`

**Output Example:**
```json
{
  "env_name": "production",
  "status": "HARD_FAIL",
  "severity_gate": "HARD_FAIL",
  "check_category": "architecture_gate",
  "issue_count": 2,
  "execution_time_ms": 183.12,
  "result_summary": {
    "derived_has_1m_rows": 0,
    "active_lookback_minutes": 120,
    "missing_recent_5m_for_active_symbols": 2,
    "missing_recent_1h_for_active_symbols": 0,
    "recency_minutes_5m": 30,
    "recency_minutes_1h": 360
  },
  "issue_details": [
    {
      "canonical_symbol": "GBPUSD",
      "missing_5m_recent": true,
      "missing_1h_recent": false,
      "severity": "HARD_FAIL"
    }
  ]
}
```

**Action on HARD_FAIL:**
- Worker continues running remaining checks (for diagnostics)
- Overall status remains `HARD_FAIL`
- `ops_issues` row created
- Alert system triggers critical notification
- Deployment gates blocked (if integrated with CI/CD)

---

### RPC 3: `rpc_check_duplicates`

**Purpose:** Detect duplicate bars (same symbol/timeframe/timestamp)

**Signature:**
```sql
rpc_check_duplicates(
  p_env_name text,
  p_window_days int DEFAULT 7,
  p_limit int DEFAULT 100
)
```

**Logic:**
1. Scan `data_bars` and `derived_data_bars` within last N days
2. GROUP BY `(canonical_symbol, timeframe, ts_utc)` HAVING `COUNT(*) > 1`
3. Return up to `p_limit` duplicates

**Performance:**
- **Timeout:** 10 seconds (heavier scan)
- **Window:** Max 365 days (bounded)

**Output:**
```json
{
  "status": "critical",
  "check_category": "data_integrity",
  "issue_count": 5,
  "result_summary": {
    "duplicates_in_data_bars": 3,
    "duplicates_in_derived_data_bars": 2,
    "window_days": 7
  },
  "issue_details": [
    {
      "table_name": "data_bars",
      "canonical_symbol": "EURUSD",
      "timeframe": "1m",
      "ts_utc": "2026-01-14T15:23:00Z",
      "duplicate_count": 2,
      "severity": "critical"
    }
  ]
}
```

---

### RPC 4: `rpc_check_dxy_components`

**Purpose:** Validate DXY index component availability and recency

**Signature:**
```sql
rpc_check_dxy_components(
  p_env_name text,
  p_lookback_minutes int DEFAULT 30,
  p_dxy_symbols text DEFAULT 'EURUSD,USDJPY,GBPUSD,USDCAD,USDSEK,USDCHF',
  p_limit int DEFAULT 50
)
```

**Logic:**
1. Parse comma-separated DXY component symbols
2. Check each symbol has 1m bars within last N minutes
3. Flag missing or stale components

**Performance:**
- **Timeout:** 5 seconds
- **Index:** `idx_data_bars_dxy_1m_ts_sym` (optimized for DXY pairs)

**Output:**
```json
{
  "status": "critical",
  "check_category": "dxy_components",
  "issue_count": 1,
  "result_summary": {
    "total_dxy_symbols_expected": 6,
    "symbols_with_recent_data": 5,
    "symbols_missing_or_stale": 1,
    "lookback_minutes": 30
  },
  "issue_details": [
    {
      "canonical_symbol": "USDSEK",
      "latest_bar_ts": "2026-01-15T02:15:00Z",
      "staleness_minutes": 38.2,
      "severity": "critical"
    }
  ]
}
```

---

### RPC 5: `rpc_check_aggregation_reconciliation_sample`

**Purpose:** Verify derived bars match re-aggregation from source (START-LABELED)

**Signature:**
```sql
rpc_check_aggregation_reconciliation_sample(
  p_env_name text,
  p_lookback_days int DEFAULT 7,
  p_sample_size int DEFAULT 50,
  p_tolerance_ratio float DEFAULT 0.001,
  p_include_details boolean DEFAULT false
)
```

**Logic (START-LABELED):**
1. Sample N random derived bars (5m, 1h) from last M days
2. For each sampled bar at timestamp `T`:
   - Re-aggregate 1m bars WHERE `ts_utc >= T AND ts_utc < T + window_duration`
   - Example: 5m bar at 10:00 uses 1m bars [10:00, 10:01, 10:02, 10:03, 10:04]
3. Compare: `|stored_value - recalculated_value| / stored_value < tolerance`
4. Flag mismatches (OHLC, volume)

**Performance:**
- **Timeout:** 10 seconds
- **Sample:** Max 100 bars (bounded)
- **Tolerance:** 0.1% default (adjustable for rounding/precision)

**Output:**
```json
{
  "status": "warning",
  "check_category": "reconciliation",
  "issue_count": 2,
  "result_summary": {
    "sample_size": 50,
    "lookback_days": 7,
    "mismatches_found": 2,
    "tolerance_ratio": 0.001
  },
  "issue_details": [
    {
      "canonical_symbol": "EURUSD",
      "timeframe": "5m",
      "derived_ts": "2026-01-14T10:00:00Z",
      "stored_open": 1.0845,
      "recalc_open": 1.0847,
      "deviation_ratio": 0.0018,
      "severity": "warning"
    }
  ]
}
```

**Note:** This check is **START-LABELED AWARE** (fixed from previous bugs)

---

### RPC 6: `rpc_check_ohlc_integrity_sample`

**Purpose:** Validate OHLC constraints (L ≤ O,C ≤ H, etc.)

**Signature:**
```sql
rpc_check_ohlc_integrity_sample(
  p_env_name text,
  p_lookback_days int DEFAULT 7,
  p_sample_size int DEFAULT 1000,
  p_volume_min float DEFAULT 0.01
)
```

**Logic:**
1. Sample N bars from `data_bars` + `derived_data_bars`
2. Check:
   - `low <= open AND low <= close AND low <= high`
   - `high >= open AND high >= close`
   - `volume >= p_volume_min`
   - `open, close, high, low > 0`

**Performance:**
- **Timeout:** 5 seconds
- **Sample:** Max 5000 bars

**Output:**
```json
{
  "status": "critical",
  "check_category": "ohlc_integrity",
  "issue_count": 3,
  "result_summary": {
    "sample_size": 1000,
    "violations_found": 3,
    "lookback_days": 7
  },
  "issue_details": [
    {
      "table_name": "data_bars",
      "canonical_symbol": "USDJPY",
      "timeframe": "1m",
      "ts_utc": "2026-01-14T08:15:00Z",
      "open": 149.25,
      "high": 149.10,
      "low": 149.00,
      "close": 149.15,
      "violation": "high < open",
      "severity": "critical"
    }
  ]
}
```

---

### RPC 7: `rpc_check_gap_density`

**Purpose:** Detect missing bars (gaps in time series)

**Signature:**
```sql
rpc_check_gap_density(
  p_env_name text,
  p_limit int DEFAULT 100
)
```

**Logic:**
1. For each `(symbol, timeframe)`, use `LAG()` to find gaps
2. Expected interval: 1m=60s, 5m=300s, 1h=3600s
3. Flag gaps > 2x expected interval (allows minor delays)

**Performance:**
- **Timeout:** 10 seconds
- **Scan:** Recent 24 hours only (bounded)

**Output:**
```json
{
  "status": "warning",
  "check_category": "continuity",
  "issue_count": 5,
  "result_summary": {
    "total_gaps_found": 5,
    "scan_window_hours": 24
  },
  "issue_details": [
    {
      "canonical_symbol": "GBPUSD",
      "timeframe": "1m",
      "gap_start": "2026-01-15T01:23:00Z",
      "gap_end": "2026-01-15T01:28:00Z",
      "gap_minutes": 5.0,
      "expected_interval_seconds": 60,
      "severity": "warning"
    }
  ]
}
```

---

### RPC 8: `rpc_check_coverage_ratios`

**Purpose:** Measure bar ,
  p_respect_fx_weekend boolean DEFAULT true
)
```

**Weekend Suppression:**
- When `p_respect_fx_weekend=true` (default), checks are skipped on Saturday/Sunday UTC
- Avoids false positives during market closures
- Can be disabled for 24/7 feeds (crypto, commodities)
- Example: `SELECT rpc_check_coverage_ratios('production', 24, 0.95, 100, false)`

**Logic:**
1. If `p_respect_fx_weekend=true` AND today is Saturday/Sunday UTC → return early with `'pass'`
2. Count actual bars in last N hours per `(symbol, timeframe)`
3. Expected: `(lookback_hours * 60) / timeframe_minutes` (assumes 24/7 market)
4. Coverage ratio: `actual / expected`
5 p_limit int DEFAULT 100
)
```

**Logic:**
1. Count actual bars in last N hours per `(symbol, timeframe)`
2. Expected: `(lookback_hours * 60) / timeframe_minutes` (assumes 24/7 market)
3. Coverage ratio: `actual / expected`
4. Flag if `< p_min_coverage_ratio`

**Performance:**
- **Timeout:** 5 seconds

**Output:**
```json
{
  "status": "warning",
  "check_category": "coverage",
  "issue_count": 2,
  "result_summary": {
    "lookback_hours": 24,
    "min_coverage_ratio": 0.95,
    "symbols_below_threshold": 2
  },
  "issue_details": [
    {
      "canonical_symbol": "USDCAD",
      "timeframe": "1m",
      "expected_bars": 1440,
      "actual_bars": 1358,
      "coverage_ratio": 0.943,
      "severity": "warning"
    }
  ]
}
```

---

### RPC 9: `rpc_check_historical_integrity_sample`

**Purpose:** Verify older data is stable (no backfill corruption)

**Signature:**
```sql
rpc_check_historical_integrity_sample(
  p_env_name text,
  p_history_days int DEFAULT 30,
  p_sample_size int DEFAULT 100,
  p_max_recent_hours int DEFAULT 48,
  p_volume_min float DEFAULT 0.01
)
```

**Logic:**
1. Sample N bars from `[now - history_days, now - max_recent_hours]` window
2. Check OHLC integrity + contiguous timestamps (using `LAG()`)
3. Flag violations or unexpected gaps in historical data

**Performance:**
- **Timeout:** 10 seconds
- **Sample:** Max 1000 bars

**Output:**
```json
{
  "status": "pass",
  "check_category": "historical_integrity",
  "issue_count": 0,
  "result_summary": {
    "sample_size": 100,
    "violations_found": 0,
    "history_days": 30,
    "excluded_recent_hours": 48
  },
  "issue_details": []
}
```

---

## Orchestrator RPC

### `rpc_run_health_checks`

**Purpose:** Execute all validation checks, persist results, create issues

**Signature:**
```sql
rpc_run_health_checks(
  p_env_name text,
  p_mode text DEFAULT 'fast',
  p_trigger text DEFAULT 'cron'
)
```

**Parameters:**
- `p_env_name`: Environment identifier (for logging, not DB filtering)
- `p_mode`: `'fast'` (5 checks) or `'full'` (9 checks)
- `p_trigger`: `'cron'` | `'manual'` | `'api'`

**Execution Flow (Resilient Pattern):**

```
1. Generate run_id (UUID)
2. Execute checks in sequence (order matters):
   a. rpc_check_architecture_gates (HARD_FAIL first)
   b. rpc_check_staleness
   c. rpc_check_dxy_components
   d. rpc_check_aggregation_reconciliation_sample
   e. rpc_check_ohlc_integrity_sample
   [FAST mode stops here]
   f. rpc_check_duplicates (FULL only)
   g. rpc_check_gap_density (FULL only)
   h. rpc_check_coverage_ratios (FULL only)
   i. rpc_check_historical_integrity_sample (FULL only)

3. For each check (resilient error handling):
   • Execute check (catches exceptions, returns {status:'error'})
   • Persist result to quality_check_results (always succeeds)
   • If status != 'pass', create ops_issues row
   • Update overall severity (max severity of all checks)
   • Continue to next check (no rollback)

4. Persist worker run to quality_workerhealth
   • Single row summarizing the entire run
   • Contains run_id, mode, trigger, overall_status, total checks_run, issue_count

5. Return summary JSON with all check results
```

**Severity Ranking:**
```
HARD_FAIL (5) > error (4) > critical (3) > warning (2) > pass (1)
```

**Performance & Resilience:**
- **Timeout:** 60 seconds per orchestrator call
- **Resilience:** Fault-tolerant (all checks attempted, errors recorded, no rollback)
- **Guarantees:** Every check result persisted; every non-pass check creates ops_issue; worker run always logged

**Output Example:**
```json
{
  "env_name": "production",
  "run_id": "a1b2c3d4-...",
  "mode": "fast",
  "trigger": "cron",
  "overall_status": "warning",
  "checks_run": 5,
  "issue_count": 3,
  "execution_time_ms": 1247.82,
  "checks": [
    {
      "status": "pass",
      "check_category": "architecture_gate",
      "issue_count": 0,
      "execution_time_ms": 183.45,
      "result_summary": {...}
    },
    {
      "status": "warning",
      "check_category": "freshness",
      "issue_count": 3,
      "execution_time_ms": 247.35,
      "result_summary": {...},
      "issue_details": [...]
    }
  ]
}
```

---

## Cloudflare Worker Implementation

### Worker Architecture

```typescript
// apps/typescript/data-quality-validator/src/index.ts

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ENVIRONMENT_NAME: string;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const mode = this.getMode(event.cron);
    
    const result = await this.runHealthChecks(env, mode, 'cron');
    
    console.log(`[${mode}] Status: ${result.overall_status}, Issues: ${result.issue_count}`);
    
    if (result.overall_status === 'error') {
      throw new Error(`Health check failed: ${result.error_message}`);
    }
  },
  
  getMode(cron: string): 'fast' | 'full' {
    // Every 5 minutes: fast
    // Every 30 minutes: full
    return cron.includes('*/5') ? 'fast' : 'full';
  },
  
  async runHealthChecks(env: Env, mode: string, trigger: string) {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/rpc_run_health_checks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY
      },
      body: JSON.stringify({
        p_env_name: env.ENVIRONMENT_NAME,
        p_mode: mode,
        p_trigger: trigger
      })
    });
    
    if (!response.ok) {
      throw new Error(`RPC call failed: ${response.status}`);
    }
    
    return await response.json();
  }
};
```

### Cron Schedule

```toml
# wrangler.toml

[triggers]
crons = [
  "*/5 * * * *",   # Every 5 minutes (fast mode)
  "*/30 * * * *"   # Every 30 minutes (full mode)
]
```

**Decision Logic:**
- Trigger on `*/5`: Run fast mode (checks 1,2,4,5,6)
- Trigger on `*/30`: Run full mode (all 9 checks)
- Both crons fire at :00 and :30 → Full mode takes precedence

---

## Deployment & Operations

### Deployment Checklist

**Prerequisites:**
- [ ] Supabase project exists for target environment
- [ ] Tables: `data_bars`, `derived_data_bars` exist
- [ ] Extension: `pgcrypto` installed

**Step 1: Deploy SQL**
```bash
# Run the anchor script
psql $SUPABASE_DB_URL < migrations/000_full_script_data_validaton.sql
```

**Step 2: Verify Tables**
```sql
SELECT tablename FROM pg_tables 
WHERE schemaname='public' 
  AND tablename LIKE 'quality_%' OR tablename = 'ops_issues';
```

Expected: `quality_workerhealth`, `quality_check_results`, `ops_issues`

**Step 3: Test RPC (Manual)**
```sql
SELECT public.rpc_run_health_checks('dev', 'fast', 'manual');
```

**Step 4: Deploy Worker**
```bash
cd apps/typescript/data-quality-validator
pnpm install
pnpm run deploy --env production
```

**Step 5: Verify Execution**
```sql
SELECT * FROM quality_workerhealth ORDER BY created_at DESC LIMIT 5;
```

---

### Monitoring Queries

**Recent Worker Runs:**
```sql
SELECT 
  created_at,
  mode,
  status,
  checks_run,
  issue_count,
  duration_ms
FROM quality_workerhealth
ORDER BY created_at DESC
LIMIT 20;
```

**Critical Issues (Last 24h):**
```sql
SELECT 
  created_at,
  severity,
  category,
  title,
  message,
  entity->>'canonical_symbol' AS symbol
FROM ops_issues
WHERE severity IN ('critical', 'HARD_FAIL', 'error')
  AND created_at >= now() - interval '24 hours'
ORDER BY created_at DESC;
```

**Check Pass Rate (Last 7 Days):**
```sql
SELECT 
  check_category,
  COUNT(*) AS total_runs,
  COUNT(*) FILTER (WHERE status = 'pass') AS pass_count,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'pass') / COUNT(*), 2) AS pass_rate_pct
FROM quality_check_results
WHERE created_at >= now() - interval '7 days'
GROUP BY check_category
ORDER BY pass_rate_pct;
```

**Performance Trend:**
```sql
SELECT 
  check_category,
  ROUND(AVG(execution_time_ms), 2) AS avg_ms,
  ROUND(MAX(execution_time_ms), 2) AS max_ms,
  COUNT(*) AS run_count
FROM quality_check_results
WHERE created_at >= now() - interval '24 hours'
GROUP BY check_category
ORDER BY avg_ms DESC;
```

---

### Alerting Integration

**Pattern:** Query `ops_issues` table for non-pass severities

**Example (External Alert System):**
```sql
-- Query this every 5 minutes from your alerting system
SELECT 
  id,
  created_at,
  severity,
  category,
  title,
  message,
  entity,
  context
FROM ops_issues
WHERE severity IN ('critical', 'HARD_FAIL', 'error')
  AND created_at >= now() - interval '10 minutes'  -- Buffer for delays
ORDER BY created_at DESC;
```

**Recommended Actions by Severity:**

| Severity | Action | Example |
|----------|--------|---------|
| **HARD_FAIL** | Page on-call, block deployment | Architecture gate failed |
| **error** | Page on-call, escalate | RPC execution failed |
| **critical** | Alert team channel, investigate | 10+ symbols stale >15m |
| **warning** | Log to dashboard, monitor trend | 3 symbols stale >5m |
| **pass** | No action | All checks green |

---

## Maintenance

### Data Retention

**Recommended:** 90 days for all quality tables

**Manual Cleanup (Run Monthly):**
```sql
-- Delete old quality_workerhealth rows
DELETE FROM quality_workerhealth
WHERE created_at < now() - interval '90 days';

-- Delete old quality_check_results
DELETE FROM quality_check_results
WHERE created_at < now() - interval '90 days';

-- Delete old ops_issues
DELETE FROM ops_issues
WHERE created_at < now() - interval '90 days';
```

**Automated Cleanup (Future):**
Create a scheduled function or integrate with existing janitor worker.

---

### Troubleshooting

**Worker Not Running:**
1. Check Cloudflare Workers dashboard → Cron triggers
2. Verify worker deployment: `wrangler deployments list`
3. Check worker logs: Cloudflare dashboard → Logs

**RPC Timeouts:**
1. Check `execution_time_ms` in `quality_check_results`
2. If consistently timing out, reduce `p_sample_size` or `p_lookback_days`
3. Verify indexes exist: `\d+ data_bars`, `\d+ derived_data_bars`

**False Positives (Staleness):**
1. Check market hours (forex closes weekends)
2. Adjust thresholds: increase `p_warning_threshold_minutes`
3. Review `issue_details` for patterns (specific symbols always stale?)

**HARD_FAIL on Fresh Deploy:**
1. Expected if aggregator not caught up yet
2. Run `rpc_check_architecture_gates` manually with custom thresholds:
   ```sql
   SELECT rpc_check_architecture_gates('dev', 240, 60, 720, 10);
   ```
3. Once aggregator catches up, reset to defaults

---

## Performance Characteristics

### Resource Usage

| Check | Avg Execution (ms) | DB Load | Notes |
|-------|-------------------|---------|-------|
| staleness | 200-300 | Low | DISTINCT ON, indexed |
| architecture_gates | 150-250 | Low | Indexed lookups |
| duplicates | 1000-2000 | Medium | GROUP BY, 7-day scan |
| dxy_components | 100-200 | Low | Partial index |
| reconciliation | 800-1500 | Medium | Re-aggregation, 50 samples |
| ohlc_integrity | 300-500 | Low | Random sampling |
| gap_density | 1000-1500 | Medium | LAG() window function |
| coverage_ratios | 200-400 | Low | COUNT aggregation |
| historical_integrity | 500-800 | Low | Historical sample |
| **Orchestrator (fast)** | **2500-4000** | **Medium** | 5 checks total |
| **Orchestrator (full)** | **5000-8000** | **High** | 9 checks total |

### Database Impact

- **Connections:** 1 per worker execution (short-lived, via PostgREST)
- **CPU:** Minimal (queries are bounded and indexed)
- **Storage Growth:** ~1 MB per day (all quality tables combined)
- **Index Maintenance:** Auto-updated by Postgres (CONCURRENTLY created)

---

## Testing Strategy

### Unit Tests (Per RPC)

Test each RPC independently with known data scenarios:

```sql
-- Seed test data
INSERT INTO data_bars (canonical_symbol, timeframe, ts_utc, open, high, low, close, volume)
VALUES 
  ('EURUSD', '1m', now() - interval '2 minutes', 1.0850, 1.0855, 1.0848, 1.0852, 1000),
  ('EURUSD', '1m', now() - interval '1 minute', 1.0852, 1.0857, 1.0850, 1.0855, 1200);

-- Test staleness (should pass)
SELECT rpc_check_staleness('test', 5, 15, 10);

-- Verify status = 'pass'
-- Verify issue_count = 0
```

### Integration Test (Orchestrator)

```sql
-- Full run
SELECT rpc_run_health_checks('test', 'full', 'manual');

-- Verify worker run persisted
SELECT * FROM quality_workerhealth WHERE trigger = 'manual' ORDER BY created_at DESC LIMIT 1;

-- Verify check results persisted
SELECT check_category, status FROM quality_check_results 
WHERE run_id = (SELECT run_id FROM quality_workerhealth ORDER BY created_at DESC LIMIT 1);
```

### Load Test

Simulate heavy validation load:

```bash
# Run 10 concurrent fast checks
for i in {1..10}; do
  psql $DB_URL -c "SELECT rpc_run_health_checks('load-test', 'fast', 'manual')" &
done
wait
```

Monitor:
- Execution times (should stay < 5s per check)
- Database CPU/memory (should stay < 50%)
- No timeouts or errors

---

## Migration from v1.0 (Archived)

**Key Differences:**

| Aspect | v1.0 (Archived) | v2.0 (Current) |
|--------|-----------------|----------------|
| Tables | `quality_data_validation`, `quality_validation_runs` | `quality_workerhealth`, `quality_check_results`, `ops_issues` |
| RPCs | 9 validation RPCs | 9 validation RPCs + orchestrator |
| Orchestration | Worker handles persistence | Orchestrator RPC handles persistence |
| Issues Table | No dedicated table | `ops_issues` (append-only, alerting-ready) |
| Aggregation | END-LABELED (buggy) | START-LABELED (fixed) |
| Security | Basic RLS | SECURITY DEFINER + bounded params + timeouts |
| Gates | No HARD_FAIL concept | HARD_FAIL gate (architecture) |

**Migration Steps:**

1. **Do NOT drop v1.0 tables** (retain for historical analysis)
2. Deploy v2.0 schema (new tables, no conflicts)
3. Deploy v2.0 worker (update RPC calls)
4. Run v2.0 for 7 days in parallel (verify)
5. Archive v1.0 tables (rename to `_archived_*`)
6. Update dashboards/alerts to use new tables

---

## Appendix A: Complete RPC Signatures

```sql
-- Helper
rpc__severity_rank(p_status text) → int

-- Validation RPCs
rpc_check_staleness(p_env_name text, p_warning_threshold_minutes int, p_critical_threshold_minutes int, p_limit int) → jsonb

rpc_check_architecture_gates(p_env_name text, p_active_lookback_minutes int, p_5m_recency_minutes int, p_1h_recency_minutes int, p_limit int) → jsonb

rpc_check_duplicates(p_env_name text, p_window_days int, p_limit int) → jsonb

rpc_check_dxy_components(p_env_name text, p_lookback_minutes int, p_dxy_symbols text, p_limit int) → jsonb

rpc_check_aggregation_reconciliation_sample(p_env_name text, p_lookback_days int, p_sample_size int, p_tolerance_ratio float, p_include_details boolean) → jsonb

**Note:** All indexes are created normally (not CONCURRENTLY) to work within Supabase SQL transactions.

```sql
-- Data bars (validation-critical, created in anchor script)
CREATE INDEX IF NOT EXISTS idx_data_bars_sym_tf_ts 
  ON data_bars (canonical_symbol, timeframe, ts_utc DESC);

CREATE INDEX IF NOT EXISTS idx_derived_sym_tf_ts 
  ON derived_data_bars (canonical_symbol, timeframe, ts_utc DESC);

CREATE INDEX IF NOT EXISTS idx_data_bars_dxy_1m_ts_sym 
  ON data_bars (ts_utc DESC, canonical_symbol)
  WHERE timeframe='1m' AND canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF');

-- Quality tables (created in anchor script)
CREATE INDEX IF NOT EXISTS idx_quality_workerhealth_recent 
  ON quality_workerhealth (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_quality_workerhealth_status_recent 
  ON quality_workerhealth (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_issues_recent 
  ON ops_issues (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_issues_severity_recent 
  ON ops_issues (severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_quality_results_run 
  ON quality_check_results (run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_quality_results_category_time 
  ON quality_check_results (check_category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_quality_results_status_time 
  ON quality_check_results (status, created_at DESC);
```

**All indexes are included in the anchor SQL script** (`000_full_script_data_validaton.sql`) and will be created automatically when you deploy.N quality_workerhealth (status, created_at DESC);

CREATE INDEX CONCURRENTLY idx_ops_issues_recent 
  ON ops_issues (created_at DESC);

CREATE INDEX CONCURRENTLY idx_ops_issues_severity_recent 
  ON ops_issues (severity, created_at DESC);

CREATE INDEX CONCURRENTLY idx_quality_results_run 
  ON quality_check_results (run_id, created_at DESC);

CREATE INDEX CONCURRENTLY idx_quality_results_category_time 
  ON quality_check_results (check_category, created_at DESC);

CREATE INDEX CONCURRENTLY idx_quality_results_status_time 
  ON quality_check_results (status, created_at DESC);
```

---

## Appendix C: Security Hardening Checklist

- [x] All RPCs are `SECURITY DEFINER`
- [x] All RPCs set `search_path = public` (prevent injection)
- [x] All RPCs have statement timeouts (5-60s)
- [x] All RPCs validate required parameters (non-null, non-empty)
- [x] All RPCs bound parameters (min/max limits)
- [x] All RPCs have exception handlers (return error JSON, no leaks)
- [x] All RPCs revoked from `PUBLIC`, granted to `service_role` only
- [x] All tables have RLS enabled
- [x] All tables have `service_role` policies only
- [x] Worker uses `service_role` key (not `anon` key)
- [x] Worker secrets stored in Cloudflare environment variables
- [x] No dynamic SQL (all queries use parameter binding)
- [x] No user-controlled table/column names in queries

---

**End of Implementation Plan v2.0**

