# Data Quality Validation Worker - Implementation Plan v1.2 (with Worker Health Monitoring)

## Document Control
- **Version:** 1.2 (Added Worker Health Monitoring)
- **Last Updated:** 2026-01-14
- **Status:** Ready for Implementation

## Critical Changes from v1.1

### ✅ What's New in v1.2
- **Worker Health Monitoring** - Added `quality_workerhealth` table to track worker execution
- **Structured Error Logging** - Added `ops_issues` table for exceptions, timeouts, CPU limits
- **Checkpoint Tracking** - Workers now track execution progress (started, fetched, upserted, finished)
- **Optional Health RPC** - `rpc_get_worker_health_summary` for dashboard queries
- **Dashboard Widgets** - 4 new health-focused dashboard widgets
- **Alerting Rules** - Critical-only alerts (dead workers, HARD_FAIL, failure rate)
- **Execution Metrics** - Duration, retry counts, HTTP 429 tracking, RPC timings

### ✅ What Was Correct in v1.1
1. **DXY location wrong** - Said "DXY in derived_data_bars" → CORRECT: DXY 1m in data_bars
2. **Missing architecture gate** - No check for "derived must NOT have 1m"
3. **Too many queries** - 10-20 SQL calls per run → CORRECT: 3-6 RPC calls
4. **Wrong aggregation logic** - "Exactly 5 bars" → CORRECT: Quality-score model (5→2, 4→1, 3→0, <3→skip)
5. **Schedule conflicts** - Every 5 min overlaps with ingestion → CORRECT: Offset schedules
6. **Alerting unnecessary** - Removed - use dashboard queries on quality_data_validation table

### ✅ What's Correct Now
- DXY 1m in data_bars, 5m/1h/1d in derived_data_bars
- Architecture gate (HARD_FAIL if derived has 1m)
- RPC-based (3-6 calls per run max)
- Quality-score aware aggregation checks
- Conflict-avoidant schedules
- Dashboard-only (no separate alerting system)

---

## Executive Summary

Convert Python validation scripts to **Cloudflare Worker** using **RPC pattern** (3-6 DB calls per run) to avoid subrequest pressure. Store results in `quality_data_validation` table. Build dashboard later to visualize trends.

**Key Architectural Truths:**
- DXY 1m lives in `data_bars` (computed from 6 component currencies)
- DXY 5m/1h/1d live in `derived_data_bars` (aggregated from DXY 1m)
- `derived_data_bars` must NEVER contain timeframe='1m' (architecture gate)
- Validations use RPC pattern to avoid subrequest/DB pressure
- Quality-score model: 5 bars→score:2, 4→1, 3→0, <3→skip (no derived bar)

---

## MVP Implementation Strategy

### Three Validation Types

#### 1. Quick Health (Every 15 min, offset from ingestion)
**Cron:** `3,18,33,48 * * * *`  
**RPC Calls (3):**
- `rpc_check_staleness` - All symbols, both tables
- `rpc_check_architecture_gate` - HARD_FAIL gate
- `rpc_check_duplicates` - Both tables

**Execution Target:** < 15 seconds

#### 2. Daily Correctness (3 AM UTC, after aggregation)
**Cron:** `0 3 * * *`  
**RPC Calls (6):**
- All from Quick Health (3)
- `rpc_check_dxy_components` - DXY 1m component availability
- `rpc_check_aggregation_quality_sample` - Quality-score validation (sample 50 buckets)
- `rpc_check_ohlc_integrity` - Sample 1000 bars for OHLC checks

**Execution Target:** < 25 seconds

#### 3. Weekly Deep (Sunday 4 AM UTC)
**Cron:** `0 4 * * 0`  
**RPC Calls (3):**
- `rpc_check_gap_density` - 12-week window
- `rpc_check_coverage_ratios` - Long-term coverage
- `rpc_check_historical_integrity` - Sampled historical checks

**Execution Target:** < 28 seconds

---

## Dashboard Specifications (No Separate Alerting)

All monitoring via direct queries on `quality_data_validation` table.

### Widget 1: Latest Status Board
Shows most recent status per check_category with colored badges (pass/warning/critical/error).

**Query:**
```sql
SELECT DISTINCT ON (check_category, table_name, timeframe)
  check_category,
  table_name,
  timeframe,
  status,
  issue_count,
  severity_gate,
  result_summary,
  run_timestamp
FROM quality_data_validation
WHERE env_name = 'PROD'
ORDER BY check_category, table_name, timeframe, run_timestamp DESC;
```

### Widget 2: Trend Charts (Last 7 Days)
Line charts showing issue counts over time.

**Query:**
```sql
SELECT 
  DATE_TRUNC('hour', run_timestamp) as time_bucket,
  check_category,
  status,
  AVG(issue_count) as avg_issues,
  MAX(issue_count) as max_issues
FROM quality_data_validation
WHERE env_name = 'PROD'
  AND run_timestamp >= NOW() - INTERVAL '7 days'
GROUP BY time_bucket, check_category, status
ORDER BY time_bucket DESC;
```

### Widget 3: Quick Filters
Filter by symbol, timeframe, validation_type, check_category.

### Widget 4: Drill-Down Modal
Click any result → see full `result_summary` and `issue_details` JSONB.

### Widget 5: DXY-Specific Health
Dedicated view for DXY quality across all timeframes (1m/5m/1h).

### Widget 6: Per-Asset Quality Scorecard
Health score per asset based on pass/warning/critical ratio.

---

## Database Schema

### quality_data_validation Table

```sql
CREATE TABLE quality_data_validation (
    id BIGSERIAL PRIMARY KEY,
    
    -- Run metadata
    run_id UUID NOT NULL DEFAULT gen_random_uuid(),
    run_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    env_name TEXT NOT NULL, -- 'PROD', 'STAGING', 'DEV'
    job_name TEXT NOT NULL DEFAULT 'data_quality_validator',
    validation_type VARCHAR(50) NOT NULL, -- 'quick_health', 'daily_correctness', 'weekly_deep'
    check_category VARCHAR(100) NOT NULL, -- 'freshness', 'duplicates', 'architecture_gate', etc.
    
    -- Scope
    canonical_symbol VARCHAR(20), -- NULL for global checks
    timeframe VARCHAR(10), -- '1m', '5m', '1h', '1d', NULL for N/A
    table_name VARCHAR(100) NOT NULL, -- 'data_bars' or 'derived_data_bars'
    
    -- Time window checked
    window_start TIMESTAMPTZ,
    window_end TIMESTAMPTZ,
    
    -- Results
    status VARCHAR(20) NOT NULL, -- 'pass', 'warning', 'critical', 'error'
    severity_gate TEXT, -- 'HARD_FAIL' or 'WARN_ONLY'
    issue_count INTEGER DEFAULT 0,
    
    -- Detailed results (JSON) - KEEP SMALL (max 50-100 samples)
    result_summary JSONB NOT NULL, -- High-level summary stats (REQUIRED)
    issue_details JSONB, -- Sampled issue records (MAX 100 rows)
    
    -- Thresholds and configuration
    threshold_config JSONB,
    
    -- Metadata
    worker_version VARCHAR(50),
    execution_duration_ms INTEGER,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_quality_validation_run_id ON quality_data_validation(run_id);
CREATE INDEX idx_quality_validation_timestamp ON quality_data_validation(run_timestamp DESC);
CREATE INDEX idx_quality_validation_env_job ON quality_data_validation(env_name, job_name, run_timestamp DESC);
CREATE INDEX idx_quality_validation_symbol ON quality_data_validation(canonical_symbol) WHERE canonical_symbol IS NOT NULL;
CREATE INDEX idx_quality_validation_status ON quality_data_validation(status) WHERE status IN ('warning', 'critical', 'error');
CREATE INDEX idx_quality_validation_category ON quality_data_validation(check_category);
CREATE INDEX idx_quality_validation_gate ON quality_data_validation(severity_gate) WHERE severity_gate = 'HARD_FAIL';
CREATE INDEX idx_quality_validation_symbol_category_time 
    ON quality_data_validation(canonical_symbol, check_category, run_timestamp DESC);

COMMENT ON TABLE quality_data_validation IS 
    'Automated data quality validation results. Retention: 90 days via janitor.';
COMMENT ON COLUMN quality_data_validation.severity_gate IS 
    'HARD_FAIL = blocks deployment/critical, WARN_ONLY = monitoring only';
COMMENT ON COLUMN quality_data_validation.issue_details IS 
    'Sample max 50-100 rows. Always store counts in result_summary.';
```

### Janitor Function

```sql
CREATE OR REPLACE FUNCTION cleanup_quality_validation_old_records()
RETURNS void AS $$
BEGIN
    DELETE FROM quality_data_validation
    WHERE run_timestamp < NOW() - INTERVAL '90 days';
    
    DELETE FROM quality_validation_runs
    WHERE run_timestamp < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;
```

---

## Worker Health Monitoring

### Overview
Track worker execution health, detect timeouts/CPU limits, and monitor execution checkpoints. Provides "worker alive" visibility independent of data quality validation results.

### Schema: quality_workerhealth

Append-only health record per worker run.

```sql
CREATE TABLE quality_workerhealth (
  id BIGSERIAL PRIMARY KEY,
  env_name TEXT NOT NULL,
  worker_name TEXT NOT NULL, -- 'ingestion', 'aggregation', 'data-quality-validator'
  run_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL, -- 'success', 'warning', 'error'
  duration_ms INT,
  last_success_ts TIMESTAMPTZ, -- worker computes and writes it
  last_error_ts TIMESTAMPTZ,
  error_count INT DEFAULT 0,
  error_samples JSONB, -- top N error strings / codes
  metrics JSONB, -- rows_written, assets_processed, http_429, cpu_ms, checkpoints, etc.
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workerhealth_env_worker_ts 
  ON quality_workerhealth(env_name, worker_name, run_ts DESC);

CREATE INDEX idx_workerhealth_env_worker_status 
  ON quality_workerhealth(env_name, worker_name, status, run_ts DESC);
```

**Metrics JSONB Schema Example:**
```json
{
  "checkpoint": {
    "started": true,
    "fetched": true,
    "upserted": true,
    "finished": false
  },
  "assets_total": 11,
  "assets_ok": 10,
  "assets_failed": 1,
  "rpc_timings_ms": {
    "upsert_bars_batch": 420,
    "ingest_asset_finish": 30
  },
  "http_429_count": 2,
  "retry_count": 5
}
```

### Schema: ops_issues

Append-only structured error log for exceptions, warnings, and operational events.

```sql
CREATE TABLE ops_issues (
  id BIGSERIAL PRIMARY KEY,
  env_name TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  severity TEXT NOT NULL, -- 'info', 'warning', 'error', 'critical'
  event_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  code TEXT, -- 'CPU_LIMIT', 'TIMEOUT', 'RPC_FAIL', 'HTTP_429', etc.
  message TEXT,
  context JSONB, -- request_id, endpoint, retry_count, asset, stack_trace, etc.
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ops_issues_env_worker_ts 
  ON ops_issues(env_name, worker_name, event_ts DESC);

CREATE INDEX idx_ops_issues_code_ts 
  ON ops_issues(code, event_ts DESC);

CREATE INDEX idx_ops_issues_severity_ts 
  ON ops_issues(severity, event_ts DESC);
```

### Worker Instrumentation Checklist

**For Each Worker (Ingestion, Aggregation, Data Quality Validator):**

✅ **Measure execution time**
- Start timestamp at cron entry
- End timestamp before return
- Calculate duration_ms

✅ **Track checkpoints**
- `started`: Handler entered
- `fetched`: Data fetched from upstream
- `upserted`: Database writes completed
- `finished`: Success return executed

✅ **Count failures**
- HTTP errors (429, 500, timeout)
- Database errors
- Validation failures
- Retry counts

✅ **Write health record**
- At end of each cron run
- Insert into `quality_workerhealth`
- Include last_success_ts and last_error_ts computed from previous runs

✅ **Log exceptions**
- Catch all exceptions
- Write to `ops_issues` with:
  - Severity (error/critical)
  - Error code
  - Stack trace in context.stack_trace
  - Request ID if available

✅ **Emit structured metrics**
- Assets processed
- Rows written
- RPC timing breakdown
- Retry counts
- HTTP 429 rate limiting hits

### Dashboard Widgets (Worker Health)

#### Widget: Ingestion Worker Health
```sql
SELECT 
  worker_name,
  run_ts,
  status,
  duration_ms,
  EXTRACT(EPOCH FROM (NOW() - run_ts)) / 60 as last_run_age_minutes,
  EXTRACT(EPOCH FROM (NOW() - last_success_ts)) / 60 as last_success_age_minutes,
  error_count,
  metrics->>'assets_total' as assets_total,
  metrics->>'assets_ok' as assets_ok,
  metrics->'checkpoint'->>'finished' as checkpoint_finished,
  error_samples->0->>'message' as last_error_snippet
FROM quality_workerhealth
WHERE env_name = 'PROD' 
  AND worker_name = 'ingestion'
ORDER BY run_ts DESC
LIMIT 1;
```

#### Widget: Aggregation Worker Health
```sql
SELECT 
  worker_name,
  run_ts,
  status,
  duration_ms,
  EXTRACT(EPOCH FROM (NOW() - run_ts)) / 60 as last_run_age_minutes,
  EXTRACT(EPOCH FROM (NOW() - last_success_ts)) / 60 as last_success_age_minutes,
  metrics->>'rows_processed' as rows_processed,
  metrics->'checkpoint'->>'finished' as checkpoint_finished
FROM quality_workerhealth
WHERE env_name = 'PROD' 
  AND worker_name = 'aggregation'
ORDER BY run_ts DESC
LIMIT 1;
```

#### Widget: Errors Last 60 Minutes
```sql
SELECT 
  code,
  severity,
  COUNT(*) as error_count,
  MAX(event_ts) as last_occurrence,
  jsonb_agg(DISTINCT message ORDER BY message) as sample_messages
FROM ops_issues
WHERE env_name = 'PROD'
  AND event_ts > NOW() - INTERVAL '60 minutes'
  AND severity IN ('error', 'critical')
GROUP BY code, severity
ORDER BY error_count DESC
LIMIT 10;
```

#### Widget: Worker Success Rate (24h)
```sql
SELECT 
  worker_name,
  COUNT(*) as total_runs,
  COUNT(*) FILTER (WHERE status = 'success') as success_runs,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'success') / COUNT(*), 2) as success_rate_pct,
  AVG(duration_ms) FILTER (WHERE status = 'success') as avg_duration_ms
FROM quality_workerhealth
WHERE env_name = 'PROD'
  AND run_ts > NOW() - INTERVAL '24 hours'
GROUP BY worker_name
ORDER BY worker_name;
```

### Optional RPC: Worker Health Summary

```sql
CREATE OR REPLACE FUNCTION rpc_get_worker_health_summary(
  p_env_name TEXT,
  p_worker_name TEXT,
  p_window_minutes INT DEFAULT 60
)
RETURNS JSONB AS $$
DECLARE
  v_result JSONB;
  v_last_run RECORD;
  v_last_success RECORD;
  v_error_count INT;
  v_success_rate FLOAT;
BEGIN
  -- Get last run
  SELECT * INTO v_last_run
  FROM quality_workerhealth
  WHERE env_name = p_env_name AND worker_name = p_worker_name
  ORDER BY run_ts DESC
  LIMIT 1;
  
  -- Get last successful run
  SELECT * INTO v_last_success
  FROM quality_workerhealth
  WHERE env_name = p_env_name 
    AND worker_name = p_worker_name 
    AND status = 'success'
  ORDER BY run_ts DESC
  LIMIT 1;
  
  -- Count errors in window
  SELECT COUNT(*) INTO v_error_count
  FROM quality_workerhealth
  WHERE env_name = p_env_name 
    AND worker_name = p_worker_name
    AND run_ts > NOW() - (p_window_minutes || ' minutes')::INTERVAL
    AND status IN ('error', 'warning');
  
  -- Calculate success rate
  SELECT 
    COALESCE(
      100.0 * COUNT(*) FILTER (WHERE status = 'success') / NULLIF(COUNT(*), 0),
      0
    ) INTO v_success_rate
  FROM quality_workerhealth
  WHERE env_name = p_env_name 
    AND worker_name = p_worker_name
    AND run_ts > NOW() - (p_window_minutes || ' minutes')::INTERVAL;
  
  v_result := jsonb_build_object(
    'worker_name', p_worker_name,
    'last_run', jsonb_build_object(
      'ts', v_last_run.run_ts,
      'status', v_last_run.status,
      'duration_ms', v_last_run.duration_ms,
      'age_minutes', ROUND(EXTRACT(EPOCH FROM (NOW() - v_last_run.run_ts)) / 60, 2)
    ),
    'last_success', jsonb_build_object(
      'ts', v_last_success.run_ts,
      'age_minutes', ROUND(EXTRACT(EPOCH FROM (NOW() - v_last_success.run_ts)) / 60, 2)
    ),
    'window_stats', jsonb_build_object(
      'window_minutes', p_window_minutes,
      'error_count', v_error_count,
      'success_rate_pct', ROUND(v_success_rate::NUMERIC, 2)
    )
  );
  
  RETURN v_result;
END;
$$ LANGUAGE plpgsql VOLATILE;
```

### Retention Policy

```sql
-- Run daily or weekly
DELETE FROM quality_workerhealth WHERE created_at < NOW() - INTERVAL '90 days';
DELETE FROM ops_issues WHERE created_at < NOW() - INTERVAL '30 days';
```

### Alerting Rules (Slack/PagerDuty)

**Critical Alerts Only:**
1. Worker hasn't run in X minutes (expected schedule + buffer)
2. HARD_FAIL architecture gate triggered (RPC 2)
3. Worker failure rate > 50% in last hour
4. 3+ consecutive failures

**Implementation:**
- Query `quality_workerhealth` and `ops_issues` periodically
- Send alert if conditions met
- Include last error snippet, run age, and dashboard link

---

## Implementation Timeline

| Phase | Duration | Deliverables |
|-------|----------|-------------|
| Phase 1: Schema + RPCs | 5-6 days | Tables (validation + health), 9 RPC functions, tested in staging |
| Phase 2: Worker Skeleton | 3-4 days | Cloudflare worker, DB connection, RPC caller |
| Phase 3: Integration | 5-6 days | Wire up 3 validation types, storage layer, health instrumentation |
| Phase 4: Testing | 4-5 days | Unit tests, integration tests, staging deploy, health monitoring |
| Phase 5: Dashboard Specs | 3-4 days | SQL queries for validation + health widgets, mockups |
| Phase 6: Production Deploy | 2-3 days | Prod deployment, cron enable, monitoring, alerts |
| **Total** | **22-28 days** | **~4-5 weeks** |

---

## Success Criteria

### Technical Success
✅ All architecture gates pass (no 1m in derived)  
✅ Worker executes on schedule without errors  
✅ Results stored correctly in quality_data_validation  
✅ DXY-specific validations using correct tables  
✅ Execution time < 30s per run  
✅ No subrequest pressure issues  
✅ 3-6 RPC calls per run (not dozens)  
✅ Worker health records written on every run  
✅ Exception logging captures timeouts, CPU limits, errors  
✅ Checkpoint tracking shows execution progress  
✅ Dashboard queries fast (<500ms per widget)

### Business Success
✅ Data quality issues detected within 15 minutes  
✅ Historical trends visible in validation results  
✅ Reduced manual validation effort  
✅ Dashboard queries ready for UI implementation  
✅ DXY quality guaranteed (critical asset)  
✅ Worker alive/dead status visible at a glance  
✅ Error rate trends tracked over time  
✅ Alert-worthy events filtered (HARD_FAIL, dead workers only)

---

## Key RPC Functions (See Full Code in Migration File)

### Data Quality Validation RPCs (9)

1. **rpc_check_staleness** - Freshness for all symbols, both tables, reports by (symbol, timeframe, table)
2. **rpc_check_architecture_gates** - HARD_FAIL if derived has 1m rows or ladder broken
3. **rpc_check_duplicates** - Duplicate detection across both tables
4. **rpc_check_dxy_components** - DXY 1m component availability (uses data_bars)
5. **rpc_check_aggregation_reconciliation_sample** - True OHLC reconciliation (derived vs source)
6. **rpc_check_ohlc_integrity_sample** - Sampled OHLC integrity checks
7. **rpc_check_gap_density** - Coverage vs expected schedule
8. **rpc_check_coverage_ratios** - Symbol coverage percentage
9. **rpc_check_historical_integrity_sample** - Price jump anomalies with proper LAG

### Worker Health RPC (Optional)

10. **rpc_get_worker_health_summary** - Last run, last success, error count, success rate

Each RPC:
- Single DB roundtrip
- Built-in sampling (max 50-1000 records depending on check)
- Returns JSONB ready for storage
- Includes summary stats
- Marked VOLATILE (not STABLE) - correct for NOW() usage
- No PARALLEL SAFE flag (incorrect for table-accessing functions)

---

## What's Next?

1. **Review & approve this plan**
2. **Implement Phase 1** (schema + RPCs in Supabase)
3. **Test RPCs directly** before worker integration
4. **Build worker** (Phase 2-3)
5. **Deploy to staging** (Phase 4)
6. **Build dashboard** (after MVP stable)

---

## Appendix: Questions for Discussion

### Data Quality Validation
1. **RPC Performance:** Should we add query result caching for expensive RPCs?
2. **Sampling Strategy:** Is 50 random 5m buckets sufficient for daily aggregation checks?
3. **Dashboard Priority:** Which widget should we build first?
4. **DXY Frequency:** Is checking DXY components every 15 minutes enough?
5. **Hard Fail Response:** What should happen when architecture gate fails?
6. **Retention:** Is 90 days enough, or should we archive to S3/GCS?

### Worker Health Monitoring
7. **Alert Threshold:** How many minutes without a run before alerting? (Suggestion: 2x expected cron interval)
8. **Checkpoint Granularity:** Should we track more fine-grained checkpoints (per-asset progress)?
9. **Error Sampling:** How many error samples to keep per run? (Current: top 5)
10. **Health RPC:** Do we need the optional `rpc_get_worker_health_summary` or just direct queries?
11. **Slack Integration:** Which Slack channel for critical alerts?
12. **CPU Timeout Detection:** Should we emit a specific "TIMEOUT_LIKELY" code when checkpoint.finished = false?

---

**END OF PLAN v1.1 (with Worker Health Monitoring)**
