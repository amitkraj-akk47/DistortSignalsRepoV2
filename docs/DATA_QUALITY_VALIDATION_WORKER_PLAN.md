# Data Quality Validation Worker - Implementation Plan (v1.1)

## Executive Summary

This document outlines a plan to convert the existing Python-based data validation scripts into a **periodic Cloudflare Worker** that runs automated quality checks on `data_bars` and `derived_data_bars` tables, with special focus on DXY (Dollar Index) data. Results will be stored in a new `quality_data_validation` table for historical tracking and alerting.

**CRITICAL ARCHITECTURE NOTES:**
- ⚠️ **DXY 1m lives in `data_bars`** (computed from components, source-of-truth for 1m)
- ⚠️ **DXY 5m/1h/1d live in `derived_data_bars`** (mandatory ladder: 1m→5m→1h)
- ⚠️ **`derived_data_bars` must NEVER contain timeframe='1m'** (architecture gate check)
- ⚠️ **Validations use RPC-pattern** (3-6 DB calls per run max) to avoid subrequest/DB pressure
- ⚠️ **Quality-score aware**: Aggregation checks enforce quality model (5 bars→score:2, 4→1, 3→0, <3→skip)
- ⚠️ **Schedule conflicts avoided**: Validator runs offset from ingestion/aggregation windows

## Current State Analysis

### Existing Validation Scripts

We have comprehensive Python-based validation scripts in `/scripts`:

#### 1. **verify_data.py** - Comprehensive Data Verification
**Phase A: Active Asset Verification (Last N Days)**
- ✅ Freshness checks with warning/critical thresholds (>5m warning, >15m critical)
- ✅ Duplicate detection in `data_bars` (1m) and `derived_data_bars` (1m/5m/1h/1d)
- ✅ Timestamp alignment checks (5m, 1h, 1d bars must align to correct intervals)
- ✅ Aggregation coverage validation (5m requires exactly 5x 1m bars, 1h requires 60x 1m)
- ✅ Timestamp monotonicity (detect out-of-order data)
- ✅ Future timestamp detection
- ✅ Enhanced OHLC integrity:
  - High >= Low
  - Open/Close within [Low, High]
  - Zero-range bar detection
  - Excessive spread detection (>10%)
- ✅ Volume integrity (negative, null, zero volume)
- ✅ Price continuity (large price jumps >10%)
- ✅ Cross-timeframe consistency (5m bars vs aggregated 1m data)
- ✅ DXY-specific checks (counts, component availability)

**Phase B: Historical Data Verification (Last N Years)**
- ✅ Historical OHLC integrity over 3-year window
- ✅ Bar counts per asset
- ✅ Gap density analysis
- ✅ Enhanced OHLC validation
- ✅ Volume integrity
- ✅ DXY component dependency (EURUSD, USDJPY, GBPUSD, USDCAD, USDSEK, USDCHF)
- ✅ DXY alignment checks (5m, 1h)
- ✅ Historical coverage guardrail

**Expected vs Actual Counts**
- ✅ Computes expected bar counts from start to now
- ✅ Coverage percentage calculation
- ✅ Missing bar identification

#### 2. **diagnose_staleness.py** - Staleness Diagnostics
- ✅ Current staleness per asset
- ✅ Bars inserted per hour (last 24h)
- ✅ Gap detection (>5 min gaps in last 24h)
- ✅ Actionable recommendations

#### 3. **check_data_bars_schema.py** & **check_source_values.py**
- ✅ Schema validation
- ✅ Source column verification in `derived_data_bars`

### Validation Coverage Summary

| Check Category | data_bars | derived_data_bars | DXY Notes |
|----------------|-----------|-------------------|-----------|
| Freshness/Staleness | ✅ 1m | ✅ 5m/1h/1d | DXY 1m from data_bars |
| Duplicates | ✅ 1m | ✅ 5m/1h/1d | Both tables |
| OHLC Integrity | ✅ 1m | ✅ 5m/1h/1d | Both tables |
| Timestamp Alignment | N/A | ✅ 5m/1h/1d | derived only |
| Aggregation Coverage | Source | ✅ 5m/1h | Quality-score aware |
| Volume Integrity | ✅ 1m | ✅ 5m/1h | If column exists |
| Price Continuity | ✅ 1m | ✅ 5m/1h | Large jumps |
| Gap Analysis | ✅ 1m | ✅ 5m/1h | Both tables |
| Component Dependency | Source | N/A | DXY 1m components |
| **Architecture Gate** | **✅** | **✅ NO 1m** | **MUST enforce** |

---

## CRITICAL: Architectural Corrections from Original Plan

### ❌ What Was Wrong in v1.0

1. **WRONG**: "DXY stored in `derived_data_bars` (not `data_bars`)"
   - **CORRECT**: DXY 1m is in `data_bars`. Only DXY 5m/1h/1d are in `derived_data_bars`

2. **WRONG**: Checking `derived_data_bars` for timeframe='1m'
   - **CORRECT**: `derived_data_bars` should have ZERO rows for timeframe='1m' (gate check)

3. **WRONG**: Porting 10-20 Python checks as 10-20 separate SQL queries
   - **CORRECT**: Consolidate into 3-6 RPC calls per run to avoid subrequest/DB pressure

4. **WRONG**: Aggregation checks using "exactly 5 bars" or "exactly 60 bars"
   - **CORRECT**: Use quality_score model: 5→2, 4→1, 3→0, <3→skip (no derived bar)

5. **WRONG**: Running every 5 minutes without considering ingestion/aggregation schedules
   - **CORRECT**: Schedule offset from ingestion/aggregation to avoid contention

### ✅ Corrected Data Flow

```
FX Pairs (EURUSD, etc.)
  └─> data_bars (1m) ──────────┐
                                │
DXY Components (6 pairs)        │
  └─> data_bars (1m each)       │
        └─> DXY 1m computed     │
              └─> data_bars (DXY 1m) ───> derived_data_bars (DXY 5m/1h/1d)
                                         ^
                                         │
                                         └─── derived_data_bars (FX 5m/1h/1d)
```

**Validation Strategy:**
- DXY 1m validation: `data_bars` WHERE canonical_symbol='DXY' AND timeframe='1m'
- DXY 5m/1h validation: `derived_data_bars` WHERE canonical_symbol='DXY' AND timeframe IN ('5m','1h','1d')
- Component check: Join DXY 1m timestamps from `data_bars` with component bars in `data_bars`

---

## Proposed Architecture

### 1. New Cloudflare Worker: `data-quality-validator`

**Worker Structure:**
```
apps/typescript/data-quality-validator/
├── src/
│   ├── index.ts              # Main worker entry point
│   ├── validations/
│   │   ├── freshnessCheck.ts
│   │   ├── duplicateCheck.ts
│   │   ├── ohlcIntegrityCheck.ts
│   │   ├── alignmentCheck.ts
│   │   ├── aggregationCoverageCheck.ts
│   │   ├── volumeIntegrityCheck.ts
│   │   ├── priceJumpCheck.ts
│   │   ├── crossTimeframeCheck.ts
│   │   ├── dxyComponentCheck.ts
│   │   └── index.ts          # Export all validations
│   ├── storage/
│   │   └── resultStorage.ts  # Store results in DB
│   ├── types.ts
│   └── config.ts
├── wrangler.toml
├── package.json
└── tsconfig.json
```

### 2. Database Schema: `quality_data_validation` Table

```sql
-- Migration: db/migrations/XXX_create_quality_data_validation.sql

CREATE TABLE quality_data_validation (
    id BIGSERIAL PRIMARY KEY,
    
    -- Run metadata
    run_id UUID NOT NULL DEFAULT gen_random_uuid(),
    run_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    env_name TEXT NOT NULL, -- 'PROD', 'STAGING', 'DEV'
    job_name TEXT NOT NULL DEFAULT 'data_quality_validator',
    validation_type VARCHAR(50) NOT NULL, -- 'quick_health', 'daily_correctness', 'weekly_deep'
    check_category VARCHAR(100) NOT NULL, -- 'freshness', 'duplicates', 'ohlc_integrity', 'architecture_gate', etc.
    
    -- Scope
    canonical_symbol VARCHAR(20), -- NULL for global checks, specific symbol for targeted checks
    timeframe VARCHAR(10), -- '1m', '5m', '1h', '1d', NULL for N/A
    table_name VARCHAR(100) NOT NULL, -- 'data_bars' or 'derived_data_bars'
    
    -- Time window checked
    window_start TIMESTAMPTZ,
    window_end TIMESTAMPTZ,
    
    -- Results
    status VARCHAR(20) NOT NULL, -- 'pass', 'warning', 'critical', 'error'
    severity_gate TEXT, -- 'HARD_FAIL' (blocks deployment), 'WARN_ONLY' (monitoring)
    issue_count INTEGER DEFAULT 0,
    
    -- Detailed results (JSON) - KEEP SMALL (max 50-100 samples)
    result_summary JSONB NOT NULL, -- High-level summary stats (REQUIRED)
    issue_details JSONB, -- Sampled issue records (MAX 100 rows, null if none)
    
    -- Thresholds and configuration
    threshold_config JSONB, -- E.g., {"warning_minutes": 5, "critical_minutes": 15}
    
    -- Metadata
    worker_version VARCHAR(50),
    execution_duration_ms INTEGER,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX idx_quality_validation_run_id ON quality_data_validation(run_id);
CREATE INDEX idx_quality_validation_timestamp ON quality_data_validation(run_timestamp DESC);
CREATE INDEX idx_quality_validation_env_job ON quality_data_validation(env_name, job_name, run_timestamp DESC);
CREATE INDEX idx_quality_validation_symbol ON quality_data_validation(canonical_symbol) WHERE canonical_symbol IS NOT NULL;
CREATE INDEX idx_quality_validation_status ON quality_data_validation(status) WHERE status IN ('warning', 'critical', 'error');
CREATE INDEX idx_quality_validation_category ON quality_data_validation(check_category);
CREATE INDEX idx_quality_validation_gate ON quality_data_validation(severity_gate) WHERE severity_gate = 'HARD_FAIL';

-- Composite index for dashboards
CREATE INDEX idx_quality_validation_symbol_category_time 
    ON quality_data_validation(canonical_symbol, check_category, run_timestamp DESC);

-- Join with ops_runlog if needed
CREATE INDEX idx_quality_validation_env_runid ON quality_data_validation(env_name, run_id);

COMMENT ON TABLE quality_data_validation IS 
    'Automated data quality validation results. Retention: 90 days via janitor cron.';
COMMENT ON COLUMN quality_data_validation.severity_gate IS 
    'HARD_FAIL = blocks deployment/critical alert, WARN_ONLY = monitoring only';
COMMENT ON COLUMN quality_data_validation.issue_details IS 
    'Sample max 50-100 rows. Always store counts in result_summary, not full arrays.';
```

### 3. Additional Supporting Tables

```sql
-- Track validation run configuration and overall health
CREATE TABLE quality_validation_runs (
    run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    env_name TEXT NOT NULL,
    job_name TEXT NOT NULL DEFAULT 'data_quality_validator',
    validation_types TEXT[] NOT NULL, -- ['quick_health', 'daily_correctness']
    total_checks INTEGER NOT NULL,
    passed_checks INTEGER NOT NULL,
    warning_checks INTEGER NOT NULL,
    critical_checks INTEGER NOT NULL,
    error_checks INTEGER NOT NULL,
    hard_fail_count INTEGER NOT NULL DEFAULT 0, -- Count of severity_gate='HARD_FAIL' failures
    execution_duration_ms INTEGER,
    worker_version VARCHAR(50),
    config JSONB, -- Full config snapshot
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_quality_runs_timestamp ON quality_validation_runs(run_timestamp DESC);
CREATE INDEX idx_quality_runs_env ON quality_validation_runs(env_name, run_timestamp DESC);
CREATE INDEX idx_quality_runs_hard_fail ON quality_validation_runs(hard_fail_count) WHERE hard_fail_count > 0;



-- Janitor retention policy (implement as cron or pg_cron)
-- Run daily at 4 AM to clean old validation results
-- Keep 90 days of detailed records
CREATE OR REPLACE FUNCTION cleanup_quality_validation_old_records()
RETURNS void AS $$
BEGIN
    DELETE FROM quality_data_validation
    WHERE run_timestamp < NOW() - INTERVAL '90 days';
    
    DELETE FROM quality_validation_runs
    WHERE run_timestamp < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_quality_validation_old_records() IS 
    'Janitor: Clean validation records older than 90 days. Schedule via cron or pg_cron.';
```

---

## Critical Transport & Infrastructure Requirements

### ⚠️ MANDATORY: Hyperdrive (Direct Postgres), NOT Supabase REST

**This is a hard architectural requirement that blocks implementation.**

The entire RPC-based approach depends on:
```
Worker → Hyperdrive → Postgres (1 roundtrip per RPC call)
```

**MUST NOT use:**
- Supabase REST API (every RPC call = subrequest → subrequest limits)
- Indirect routing (adds latency + subrequest overhead)

**Why:**
- Quick health (3 RPCs) must complete in <15s
- Daily correctness (6 RPCs) must complete in <25s
- Each RPC = 1 DB roundtrip (via Hyperdrive connection pool)
- 9 RPCs × multiple weekly runs = impossible with REST API

**Supabase/Postgres direct connection via Hyperdrive is non-negotiable.**

See [Configuration Management → Database Connection](#database-connection) for implementation details.

---

## Implementation Plan

### Phase 0: RPC Suite – Explicit Specifications (BLOCKING)

**Duration:** 2-3 days (planning + signature lock-in)

**Purpose:** Make the RPC suite buildable, not conceptual. Every RPC has a locked signature, windowing rules, output contract, and performance SLA.

#### RPC 1: rpc_check_staleness

**Signature:**
```sql
rpc_check_staleness(
  env_name TEXT,
  window_minutes INT DEFAULT 20,
  warning_threshold_minutes INT DEFAULT 5,
  critical_threshold_minutes INT DEFAULT 15
)
```

**Windowing:** Last N minutes (bounded by window_minutes, max 1440 = 1 day)

**Output Contract (JSONB):**
```json
{
  "status": "pass|warning|critical|error",
  "check_category": "freshness",
  "issue_count": 3,
  "result_summary": {
    "total_assets_checked": 47,
    "stale_assets_warning": 3,
    "stale_assets_critical": 0,
    "max_staleness_minutes": 8.5,
    "avg_staleness_minutes": 2.1,
    "tables_checked": ["data_bars", "derived_data_bars"]
  },
  "issue_details": [
    {"canonical_symbol": "EURUSD", "latest_bar_ts": "2026-01-14T09:51:30Z", "staleness_minutes": 8.5, "severity": "warning"}
  ]
}
```

**Performance SLA:** Must complete in <2 seconds

**Acceptance Criteria:**
- Queries both `data_bars` (1m) and `derived_data_bars` (5m/1h/1d)
- Returns staleness in minutes (NOW() - max_ts_utc) / 60
- Samples max 100 stale symbols
- Status = 'critical' if any asset > critical_threshold, 'warning' if > warning_threshold, else 'pass'

---

#### RPC 2: rpc_check_architecture_gates

**Signature:**
```sql
rpc_check_architecture_gates(
  env_name TEXT
)
```

**Windowing:** Unbounded (checks all data)

**Output Contract (JSONB):**
```json
{
  "status": "pass|HARD_FAIL",
  "severity_gate": "HARD_FAIL",
  "check_category": "architecture_gate",
  "issue_count": 127,
  "result_summary": {
    "gate_1_derived_has_1m_rows": 127,
    "gate_2_1m_to_5m_ladder_gaps": 0,
    "gate_3_5m_to_1h_ladder_gaps": 0,
    "all_gates_pass": false
  },
  "issue_details": [
    {"canonical_symbol": "EURUSD", "timeframe": "1m", "bar_count": 50, "table": "derived_data_bars"}
  ]
}
```

**Performance SLA:** Must complete in <2 seconds

**Acceptance Criteria:**
- Status = 'HARD_FAIL' if `SELECT COUNT(*) FROM derived_data_bars WHERE timeframe='1m'` > 0
- Always returns HARD_FAIL status (not pass/warning/critical) if any gate fails
- Samples max 100 violation rows
- This RPC runs FIRST in every validation suite

---

#### RPC 3: rpc_check_duplicates

**Signature:**
```sql
rpc_check_duplicates(
  env_name TEXT,
  window_days INT DEFAULT 7
)
```

**Windowing:** Last N days (bounded by window_days, max 365)

**Output Contract (JSONB):**
```json
{
  "status": "pass|warning|critical",
  "check_category": "duplicates",
  "issue_count": 5,
  "result_summary": {
    "total_duplicate_sets": 5,
    "by_table": {
      "data_bars": 2,
      "derived_data_bars": 3
    },
    "by_timeframe": {
      "1m": 2,
      "5m": 2,
      "1h": 1
    }
  },
  "issue_details": [
    {"canonical_symbol": "EURUSD", "timeframe": "1m", "ts_utc": "2026-01-14T09:00:00Z", "duplicate_count": 2}
  ]
}
```

**Performance SLA:** Must complete in <1 second

**Acceptance Criteria:**
- Groups by (canonical_symbol, timeframe, ts_utc) in both tables
- Finds count(*) > 1 → duplicate
- Status = 'critical' if duplicates > 10, 'warning' if > 0, else 'pass'
- Samples max 100 duplicates

---

#### RPC 4: rpc_check_dxy_components

**Signature:**
```sql
rpc_check_dxy_components(
  env_name TEXT,
  window_days INT DEFAULT 7,
  tolerance_mode TEXT DEFAULT 'strict'  -- 'strict'|'degraded'|'lenient'
)
```

**Windowing:** Last N days, bounded by window_days

**Output Contract (JSONB):**
```json
{
  "status": "pass|warning|critical",
  "check_category": "dxy_components",
  "issue_count": 12,
  "result_summary": {
    "total_dxy_bars_checked": 180,
    "bars_with_complete_components": 168,
    "bars_with_degraded_components": 12,
    "bars_with_critical_components": 0,
    "coverage_percentage": 93.33,
    "components_required": 6,
    "missing_component_types": ["USDSEK", "USDCHF"]
  },
  "issue_details": [
    {"ts_utc": "2026-01-14T09:15:00Z", "available_components": 4, "found": ["EURUSD","USDJPY","GBPUSD","USDCAD"], "severity": "warning"}
  ]
}
```

**Performance SLA:** Must complete in <3 seconds

**Tolerance Thresholds:**
- **strict mode** (6/6 required): Status = critical if < 6, warning if any missing
- **degraded mode** (5/6 acceptable): Status = warning if 5/6, critical if ≤ 4/6
- **lenient mode** (3/6 minimum): Status = critical if < 3/6

**Acceptance Criteria:**
- Queries DXY 1m bars from `data_bars` (not derived_data_bars)
- Joins with 6 component FX pairs in `data_bars`
- Samples max 100 issues
- Mode selectable via config (default: strict)

---

#### RPC 5: rpc_check_aggregation_reconciliation_sample

**Signature:**
```sql
rpc_check_aggregation_reconciliation_sample(
  env_name TEXT,
  window_days INT DEFAULT 7,
  sample_size INT DEFAULT 50,
  ohlc_tolerance JSONB DEFAULT '{"rel_high_low": 1e-4, "abs_high_low": 1e-6, "rel_open_close": 1e-4}'
)
```

**Windowing:** Last N days, bounded by window_days

**Output Contract (JSONB):**
```json
{
  "status": "pass|warning|critical",
  "check_category": "aggregation_reconciliation",
  "issue_count": 4,
  "result_summary": {
    "quality_score_definition": {
      "5_bars": 2,
      "4_bars": 1,
      "3_bars": 0,
      "<3_bars": "skip"
    },
    "5m_aggregation": {
      "total_5m_bars_sampled": 50,
      "bars_with_quality_issues": 1,
      "reconciliation_failures": 2,
      "quality_score_distribution": {"2": 40, "1": 8, "0": 2}
    },
    "1h_aggregation": {
      "total_1h_bars_sampled": 50,
      "bars_with_quality_issues": 0,
      "reconciliation_failures": 0,
      "quality_score_distribution": {"2": 48, "1": 2, "0": 0}
    }
  },
  "issue_details": [
    {"symbol": "EURUSD", "ts_utc": "2026-01-14T09:00:00Z", "aggregation_level": "5m", "source_bar_count": 2, "expected_quality_score": 0, "actual_quality_score": 1, "reconciliation_failure": true}
  ]
}
```

**Performance SLA:** Must complete in <5 seconds

**Acceptance Criteria:**
- Samples 50 random 5m buckets per symbol
- For each: COUNT(1m source bars) → bar_count, assign quality_score (5→2, 4→1, 3→0)
- If bar_count < 3 and derived bar exists → reconciliation_failure
- Compute expected OHLC from source bars, compare to stored within epsilon
- Samples max 100 issues
- Status = critical if reconciliation_failures > 5, warning if > 0, else pass

---

#### RPC 6: rpc_check_ohlc_integrity_sample

**Signature:**
```sql
rpc_check_ohlc_integrity_sample(
  env_name TEXT,
  window_days INT DEFAULT 7,
  sample_size INT DEFAULT 5000,
  spread_threshold FLOAT DEFAULT 0.10
)
```

**Windowing:** Last N days, bounded by window_days

**Output Contract (JSONB):**
```json
{
  "status": "pass|warning|critical",
  "check_category": "ohlc_integrity",
  "issue_count": 8,
  "result_summary": {
    "total_bars_sampled": 5000,
    "high_less_than_low": 0,
    "open_out_of_range": 1,
    "close_out_of_range": 0,
    "zero_range_bars": 5,
    "excessive_spread": 2
  },
  "issue_details": [
    {"symbol": "EURUSD", "timeframe": "1m", "ts_utc": "2026-01-14T09:00:00Z", "issue_type": "open_out_of_range", "open": 1.0999, "low": 1.1001, "high": 1.1050}
  ]
}
```

**Performance SLA:** Must complete in <2 seconds

**Acceptance Criteria:**
- Samples random rows from both data_bars (1m) and derived_data_bars (5m/1h)
- Checks: high >= low, open/close within [low, high], zero-range, spread > 10%
- Status = critical if issues > 10, warning if > 0, else pass
- Samples max 100 issues

---

#### RPC 7: rpc_check_gap_density

**Signature:**
```sql
rpc_check_gap_density(
  env_name TEXT,
  window_weeks INT DEFAULT 4,
  max_gap_bars INT DEFAULT 10
)
```

**Windowing:** Last N weeks, bounded by window_weeks (max 52)

**Output Contract (JSONB):**
```json
{
  "status": "pass|warning|critical",
  "check_category": "gap_density",
  "issue_count": 3,
  "result_summary": {
    "total_symbols_scanned": 47,
    "symbols_with_gaps": 3,
    "total_gap_minutes": 1250,
    "gap_density_percentage": 0.35,
    "max_consecutive_missing_bars": 7
  },
  "issue_details": [
    {"symbol": "EURUSD", "gap_start": "2026-01-10T12:00:00Z", "gap_end": "2026-01-10T12:07:00Z", "missing_bar_count": 7, "business_hours_gap": true}
  ]
}
```

**Performance SLA:** Must complete in <6 seconds

**Acceptance Criteria:**
- Generates expected 1m bar times (business hours only)
- Finds missing bars (expected but not in data_bars)
- Calculates gap_density = (missing_count / total_expected) * 100
- Status = critical if density > 1%, warning if > 0.1%, else pass
- Samples max 100 gaps

---

#### RPC 8: rpc_check_coverage_ratios

**Signature:**
```sql
rpc_check_coverage_ratios(
  env_name TEXT,
  window_weeks INT DEFAULT 4,
  min_coverage_percent FLOAT DEFAULT 95.0
)
```

**Windowing:** Last N weeks, bounded by window_weeks

**Output Contract (JSONB):**
```json
{
  "status": "pass|warning|critical",
  "check_category": "coverage_ratios",
  "issue_count": 1,
  "result_summary": {
    "window_weeks": 4,
    "total_symbols_scanned": 47,
    "symbols_below_threshold": 1,
    "min_coverage_percent_threshold": 95.0
  },
  "coverage_by_symbol": [
    {"symbol": "EURUSD", "expected_bars": 14400, "actual_bars": 14350, "coverage_percent": 99.65},
    {"symbol": "USDSEK", "expected_bars": 14400, "actual_bars": 13900, "coverage_percent": 96.53}
  ]
}
```

**Performance SLA:** Must complete in <4 seconds

**Acceptance Criteria:**
- For each symbol: expected_bars = business_hours_in_window * 60
- actual_bars = COUNT(*) from data_bars
- coverage_percent = (actual_bars / expected_bars) * 100
- Status = critical if any symbol < min_coverage, warning if borderline (within 1%), else pass

---

#### RPC 9: rpc_check_historical_integrity_sample

**Signature:**
```sql
rpc_check_historical_integrity_sample(
  env_name TEXT,
  window_weeks INT DEFAULT 12,
  sample_size INT DEFAULT 10000,
  price_jump_threshold FLOAT DEFAULT 0.10
)
```

**Windowing:** Last N weeks, bounded by window_weeks (max 52)

**Output Contract (JSONB):**
```json
{
  "status": "pass|warning|critical",
  "check_category": "historical_integrity",
  "issue_count": 15,
  "result_summary": {
    "historical_window_weeks": 12,
    "total_bars_sampled": 10000,
    "ohlc_integrity_errors": 12,
    "price_jump_anomalies": 3,
    "timestamp_monotonicity_failures": 0
  },
  "issue_details": [
    {"symbol": "GBPUSD", "ts_utc": "2025-06-15T14:00:00Z", "anomaly_type": "ohlc_integrity", "details": "open_out_of_range"}
  ]
}
```

**Performance SLA:** Must complete in <8 seconds (or timeout gracefully)

**Acceptance Criteria:**
- Samples 10k random bars from 1-year window
- Runs OHLC checks + price jumps + monotonicity
- Status = critical if errors > 20, warning if > 5, else pass
- Samples max 100 anomalies

---

**Phase 0 Deliverables:**
- [ ] Signed-off RPC specification document (this section)
- [ ] TypeScript types for all RPC inputs/outputs
- [ ] RPC stubs in `db/migrations/XXX_create_quality_validation_rpcs.sql`
- [ ] Hyperdrive connection requirement document (see below)

---

### Phase 1: Database Schema & Infrastructure (Week 1)
**Duration:** 3-4 days

**Tasks:**
1. ✅ Create migration for `quality_data_validation` table
2. ✅ Create migration for `quality_validation_runs` table (optional)
3. ✅ Create migration for `quality_validation_alerts` table (optional)
4. ✅ Set up retention policies (trigger or cron)
5. ✅ Test migrations in staging environment

**Deliverables:**
- `db/migrations/XXX_create_quality_validation_tables.sql`
- Verified schema in staging

---

### Phase 2: Core Worker Setup (Week 1-2)
**Duration:** 4-5 days

**Tasks:**
1. ✅ Initialize new Cloudflare Worker project: `data-quality-validator`
2. ✅ Configure `wrangler.toml` with:
   - Scheduled triggers (cron expressions)
   - Database bindings (Supabase via Hyperdrive)
   - Environment variables
3. ✅ Implement worker entry point with routing:
   ```typescript
   export default {
     async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
       // Run validations based on schedule
     },
     async fetch(request: Request, env: Env, ctx: ExecutionContext) {
       // Manual trigger endpoint for testing
     }
   }
   ```
4. ✅ Set up database client and connection pooling
5. ✅ Implement result storage layer (`resultStorage.ts`)
6. ✅ Add error handling and retry logic

**Deliverables:**
- Working skeleton worker with DB connection
- Manual trigger endpoint for testing
- Basic logging infrastructure

---

### Phase 3: Implement RPC Suite (Week 2-3)
**Duration:** 7-10 days

**Strategy:** Consolidate validation logic into 6 core RPC functions (quick health) + 3 daily + 3 weekly. Each RPC returns JSONB with summary stats + sampled issues (max 100 rows).

#### Quick Health RPC Suite (Every 15 minutes)

**RPC 1: rpc_check_staleness**
```sql
-- Inputs:
  env_name TEXT,
  window_minutes INT DEFAULT 20,
  warning_threshold INT DEFAULT 5,
  critical_threshold INT DEFAULT 15

-- Outputs: JSONB
{
  "total_assets_checked": 47,
  "stale_assets": 3,
  "max_staleness_minutes": 8.5,
  "warning_count": 3,
  "critical_count": 0,
  "sampled_issues": [
    {"canonical_symbol": "EURUSD", "latest_bar_ts": "2026-01-14T09:51:30Z", "staleness_minutes": 8.5, "severity": "warning"}
  ]
}

-- Logic:
  SELECT MAX(ts_utc) per symbol in both data_bars (1m) and derived_data_bars (5m/1h/1d)
  Calculate staleness_minutes = (NOW() - max_ts_utc) / 60
  Flag warning if > warning_threshold, critical if > critical_threshold
  Sample max 100 stale symbols
```

**RPC 2: rpc_check_architecture_gates**
```sql
-- Inputs:
  env_name TEXT

-- Outputs: JSONB
{
  "violations": {
    "derived_has_1m_rows": 127,  -- HARD_FAIL
    "1m_to_5m_ladder_missing": 0,
    "5m_to_1h_ladder_missing": 0
  },
  "severity_gate": "HARD_FAIL",
  "sampled_violations": [
    {"canonical_symbol": "EURUSD", "timeframe": "1m", "bar_count": 50, "table": "derived_data_bars"}
  ]
}

-- Logic:
  SELECT COUNT(*) FROM derived_data_bars WHERE timeframe='1m' → if > 0, HARD_FAIL
  Verify ladder: for each 5m bar, exists 1m parent in data_bars
  Sample max 100 violation rows
```

**RPC 3: rpc_check_duplicates**
```sql
-- Inputs:
  env_name TEXT,
  window_days INT DEFAULT 7

-- Outputs: JSONB
{
  "total_potential_duplicates": 5,
  "by_table": {
    "data_bars": 2,
    "derived_data_bars": 3
  },
  "sampled_duplicates": [
    {"canonical_symbol": "EURUSD", "timeframe": "1m", "ts_utc": "2026-01-14T09:00:00Z", "count": 2}
  ]
}

-- Logic:
  GROUP BY (canonical_symbol, timeframe, ts_utc) in both tables
  Find count(*) > 1 → duplicate
  Sample max 100 duplicates
```

---

#### Daily Correctness RPC Suite (Every day at 3 AM)

**RPC 4: rpc_check_dxy_components**
```sql
-- Inputs:
  env_name TEXT,
  window_days INT DEFAULT 7

-- Outputs: JSONB
{
  "total_dxy_bars_checked": 180,
  "bars_with_missing_components": 12,
  "coverage_percentage": 93.33,
  "missing_component_types": ["USDSEK", "USDCHF"],
  "sampled_issues": [
    {"ts_utc": "2026-01-14T09:15:00Z", "available_components": 4, "found": ["EURUSD","USDJPY","GBPUSD","USDCAD"]}
  ]
}

-- Logic:
  For each DXY 1m bar in data_bars (last window_days),
  LEFT JOIN to data_bars for 6 components: EURUSD, USDJPY, GBPUSD, USDCAD, USDSEK, USDCHF
  Find bars where available_components < 6 → issue
  Sample max 100 issues
```

**RPC 5: rpc_check_aggregation_reconciliation_sample**
```sql
-- Inputs:
  env_name TEXT,
  window_days INT DEFAULT 7,
  sample_size INT DEFAULT 50

-- Outputs: JSONB
{
  "quality_score_definition": {
    "5_bars": 2,
    "4_bars": 1,
    "3_bars": 0,
    "<3_bars": "skip_derived_bar"
  },
  "5m_aggregation": {
    "total_5m_bars_sampled": 50,
    "bars_with_quality_issues": 3,
    "reconciliation_failures": 1,
    "sampled_issues": [
      {"symbol": "EURUSD", "ts_utc": "2026-01-14T09:00:00Z", "source_bar_count": 4, "expected_quality_score": 1, "stored_ohlc_mismatch": false}
    ]
  },
  "1h_aggregation": {
    "total_1h_bars_sampled": 50,
    "bars_with_quality_issues": 2,
    "reconciliation_failures": 0
  }
}

-- Logic for 5m derived bars:
  Sample random 50 5m buckets per symbol
  For each 5m bucket: COUNT(1m source bars) → bar_count
  Assign quality_score: 5→2, 4→1, 3→0
  If bar_count < 3 → DERIVED BAR MUST NOT EXIST (reconciliation failure)
  Compute expected OHLC from source 1m bars (within epsilon)
  Compare to stored OHLC in derived_data_bars → flag mismatches
  Sample max 100 issues

-- Logic for 1h derived bars:
  Sample random 50 1h buckets
  COUNT(5m source bars) → bar_count (should be 12 for complete hour)
  Use same quality-score approach (or strict: require all 12)
  Reconcile OHLC vs stored
  Sample max 100 issues
```

**RPC 6: rpc_check_ohlc_integrity_sample**
```sql
-- Inputs:
  env_name TEXT,
  window_days INT DEFAULT 7,
  sample_size INT DEFAULT 50

-- Outputs: JSONB
{
  "total_bars_checked": 5000,
  "by_issue": {
    "high_less_than_low": 0,
    "open_out_of_range": 1,
    "close_out_of_range": 0,
    "zero_range_bars": 5,
    "excessive_spread": 2
  },
  "sampled_issues": [
    {"symbol": "EURUSD", "timeframe": "1m", "ts_utc": "2026-01-14T09:00:00Z", "issue_type": "open_out_of_range", "open": 1.0999, "low": 1.1001, "high": 1.1050}
  ]
}

-- Logic:
  Sample random rows from data_bars (1m) and derived_data_bars (5m/1h)
  high >= low?
  open/close within [low, high]?
  zero-range (high == low)?
  excessive spread: (high - low) / low > 0.10?
  Sample max 100 issues
```

---

#### Weekly Deep RPC Suite (Every Sunday at 4 AM)

**RPC 7: rpc_check_gap_density**
```sql
-- Inputs:
  env_name TEXT,
  window_weeks INT DEFAULT 12

-- Outputs: JSONB
{
  "total_symbols_scanned": 47,
  "symbols_with_gaps": 3,
  "gap_density_percentage": 0.5,
  "max_consecutive_missing_bars": 7,
  "sampled_gaps": [
    {"symbol": "EURUSD", "gap_start": "2026-01-10T12:00:00Z", "gap_end": "2026-01-10T12:07:00Z", "missing_bar_count": 7}
  ]
}

-- Logic:
  For each symbol, generate expected 1m bar times (business hours only)
  Find missing bars (expected but not in data_bars)
  Calculate gap_density = (missing_count / total_expected) * 100
  Sample max 100 gaps
```

**RPC 8: rpc_check_coverage_ratios**
```sql
-- Inputs:
  env_name TEXT,
  window_weeks INT DEFAULT 12

-- Outputs: JSONB
{
  "coverage_by_symbol": [
    {"symbol": "EURUSD", "window_weeks": 12, "expected_bars": 43200, "actual_bars": 42980, "coverage_percent": 99.49},
    {"symbol": "DXY", "window_weeks": 12, "expected_bars": 43200, "actual_bars": 43200, "coverage_percent": 100.0}
  ],
  "below_threshold_symbols": 1,
  "threshold_percent": 95.0
}

-- Logic:
  For each symbol, calculate:
    expected_bars = business_hours_in_window * 60 (approx 43200 per 12 weeks)
    actual_bars = COUNT(*) from data_bars
    coverage_percent = (actual_bars / expected_bars) * 100
  Flag if < 95% coverage
```

**RPC 9: rpc_check_historical_integrity_sample**
```sql
-- Inputs:
  env_name TEXT,
  window_weeks INT DEFAULT 52

-- Outputs: JSONB
{
  "historical_window_weeks": 52,
  "total_bars_sampled": 10000,
  "ohlc_integrity_errors": 12,
  "price_jump_anomalies": 3,
  "timestamp_monotonicity_failures": 0,
  "sampled_anomalies": [
    {"symbol": "GBPUSD", "ts_utc": "2025-06-15T14:00:00Z", "anomaly_type": "ohlc_integrity", "details": "open_out_of_range"}
  ]
}

-- Logic:
  Sample random 10k bars from 1-year window
  Run OHLC integrity checks (same as RPC 6)
  Detect price jumps > 10% vs previous bar
  Check timestamp monotonicity (should be strictly increasing per symbol+timeframe)
  Sample max 100 anomalies
```

---

**Deliverables:**
- 9 RPC functions defined in `db/migrations/XXX_create_quality_validation_rpcs.sql`
- TypeScript caller in `src/rpc/client.ts` with retry logic
- Each RPC tested in Supabase editor
- Performance benchmarks (staleness: <2s, aggregation sample: <5s, gap density: <8s)

---

### Phase 4: Scheduled Execution & Configuration (Week 3)
**Duration:** 3-4 days

**Cron Schedule Design (Conflict-Avoidant):**

```toml
# wrangler.toml
# CRITICAL: Avoid overlapping with ingestion (every minute on :00)
#           and aggregation (every 5 minutes on :00, :05, :10, etc.)

[triggers]
crons = [
  # Every 15 minutes: Quick health checks (offset at :03, :18, :33, :48)
  "3,18,33,48 * * * *",
  
  # Daily at 3 AM UTC: Comprehensive validation (after aggregation settles)
  "0 3 * * *",
  
  # Weekly Sunday 4 AM UTC: Deep historical checks
  "0 4 * * 0"
]

# Note: Ingestion runs every minute at :00 seconds
#       Aggregation runs every 5 minutes at :00, :05, :10, :15, :20, etc.
#       Validator runs at :03, :18, :33, :48 to avoid contention
```

**Configuration Management (RPC-Based, Conflict-Avoidant):**
```typescript
// src/config.ts
export const VALIDATION_SCHEDULES = {
  // Quick Health: Every 15 minutes (quick checks only)
  QUICK_HEALTH: {
    cron: '3,18,33,48 * * * *', // Offset from ingestion (:00) and aggregation (:00, :05, :10, :15)
    validationType: 'quick_health',
    rpcCalls: [
      'rpc_check_staleness',           // All symbols, both tables, <2s
      'rpc_check_architecture_gates',  // Mandatory: no 1m in derived, ladder exists
      'rpc_check_duplicates',          // Both tables, <1s
    ],
    windowMinutes: 20,
    maxExecutionTime: 15000, // 15s max
  },
  
  // Daily Correctness: 3 AM UTC (after aggregation window closes)
  DAILY_CORRECTNESS: {
    cron: '0 3 * * *',
    validationType: 'daily_correctness',
    rpcCalls: [
      'rpc_check_staleness',
      'rpc_check_architecture_gates',
      'rpc_check_duplicates',
      'rpc_check_dxy_components',           // DXY component availability, <3s
      'rpc_check_aggregation_reconciliation_sample', // 5m/1h quality-score + OHLC, <5s
      'rpc_check_ohlc_integrity_sample',   // Sampled OHLC checks, <2s
    ],
    windowDays: 7,
    sampleSize: 50, // Random sample for expensive checks
    maxExecutionTime: 25000, // 25s max
  },
  
  // Weekly Deep: Sunday 4 AM UTC
  WEEKLY_DEEP: {
    cron: '0 4 * * 0',
    validationType: 'weekly_deep',
    rpcCalls: [
      'rpc_check_gap_density',              // 12-week gap analysis, <6s
      'rpc_check_coverage_ratios',          // 12-week coverage per symbol, <4s
      'rpc_check_historical_integrity_sample', // 52-week sampled checks, <8s
    ],
    windowWeeks: 12, // 3 months for weekly, 52 weeks for historical integrity
    maxExecutionTime: 28000, // 28s max
  }
};
```

**Worker Entry Point:**
```typescript
// src/index.ts
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const startTime = Date.now();
    const runId = crypto.randomUUID();
    
    try {
      // Determine which validation suite to run based on cron
      const schedule = determineSchedule(event.cron);
      
      // Execute validations
      const results = await runValidations(schedule, env, runId);
      
      // Store results in quality_data_validation table
      await storeResults(results, env, runId);
      
      console.log(`[${runId}] Validation complete in ${Date.now() - startTime}ms`);
    } catch (error) {
      console.error(`[${runId}] Validation failed:`, error);
      await logError(error, env, runId);
    }
  },
  
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Manual trigger endpoint for testing
    const url = new URL(request.url);
    
    if (url.pathname === '/validate') {
      // Parse query params for custom validation
      const validationType = url.searchParams.get('type') || 'hourly';
      // ... trigger validation manually
    }
    
    if (url.pathname === '/results') {
      // Query validation results
      // ... return recent results from DB
    }
    
    return new Response('Data Quality Validator', { status: 200 });
  }
};
```

**Deliverables:**
- Configured cron schedules
- Schedule-to-validation mapping
- Manual trigger endpoint
- Results query endpoint

---

### Phase 5: Dashboard Specifications (Week 4)
**Duration:** 3-4 days

**Purpose:** Define dashboard widget specifications for data visualization and operational monitoring. All data stored in `quality_data_validation` table - dashboard queries pull directly from this single source of truth.

#### Widget 1: Latest Validation Run Status

**Display:** Status badges (pass/warning/critical/error) per check category

**Query:**
```sql
-- Get latest run status for each check category
WITH latest_runs AS (
  SELECT DISTINCT ON (check_category, table_name, timeframe)
    check_category,
    table_name,
    timeframe,
    status,
    issue_count,
    severity_gate,
    run_timestamp,
    result_summary
  FROM quality_data_validation
  WHERE env_name = 'PROD'
  ORDER BY check_category, table_name, timeframe, run_timestamp DESC
)
SELECT 
  check_category,
  table_name,
  timeframe,
  status,
  issue_count,
  severity_gate,
  run_timestamp,
  (result_summary->>'total_assets_checked')::int as assets_checked,
  (result_summary->>'warning_count')::int as warnings,
  (result_summary->>'critical_count')::int as criticals
FROM latest_runs
ORDER BY 
  CASE status 
    WHEN 'error' THEN 1
    WHEN 'critical' THEN 2 
    WHEN 'warning' THEN 3
    WHEN 'pass' THEN 4
  END,
  check_category;
```

**Widget Display:**
```
┌─────────────────────────────────────────────────────────────┐
│ Latest Validation Status                   Last: 2m ago    │
├─────────────────────────────────────────────────────────────┤
│ ✅ freshness (data_bars/1m)           0 issues             │
│ ⚠️  duplicates (derived_data_bars/5m) 3 warnings           │
│ ❌ architecture_gate (derived/1m)     HARD_FAIL: 127 rows  │
│ ✅ dxy_components (data_bars/1m)      0 issues             │
│ ✅ ohlc_integrity (data_bars/1m)      0 issues             │
│ ⚠️  aggregation_coverage (5m)         12 partial buckets   │
└─────────────────────────────────────────────────────────────┘
```

---

#### Widget 2: Trend Charts (Last 7 Days)

**Display:** Line charts showing issue counts over time per check category

**Query:**
```sql
-- Daily trend for key metrics (last 7 days)
SELECT 
  DATE_TRUNC('hour', run_timestamp) as time_bucket,
  check_category,
  status,
  AVG(issue_count) as avg_issues,
  MAX(issue_count) as max_issues,
  COUNT(*) as run_count
FROM quality_data_validation
WHERE env_name = 'PROD'
  AND run_timestamp >= NOW() - INTERVAL '7 days'
  AND check_category IN ('freshness', 'duplicates', 'dxy_components', 'aggregation_coverage')
GROUP BY time_bucket, check_category, status
ORDER BY time_bucket DESC, check_category;
```

**Widget Display:**
```
┌─────────────────────────────────────────────────────────────┐
│ Issue Trends (Last 7 Days)                                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  20 ┤                  Freshness Issues                     │
│  15 ┤          ╭──╮                                         │
│  10 ┤     ╭────╯  ╰─╮                                       │
│   5 ┤─────╯         ╰────────                              │
│   0 ┼──────────────────────────────────────────            │
│     └─Mon──Tue──Wed──Thu──Fri──Sat──Sun                   │
│                                                             │
│  50 ┤           Aggregation Coverage Issues                │
│  40 ┤                                                       │
│  30 ┤          ╭──────╮                                     │
│  20 ┤     ╭────╯      ╰────╮                               │
│  10 ┤─────╯                ╰─────                          │
│   0 ┼──────────────────────────────────────────            │
│     └─Mon──Tue──Wed──Thu──Fri──Sat──Sun                   │
└─────────────────────────────────────────────────────────────┘
```

---

#### Widget 3: Quick Filters

**Purpose:** Filter validation results by symbol, timeframe, validation type

**Query (with filters):**
```sql
-- Parameterized query for filtered results
SELECT 
  run_timestamp,
  validation_type,
  check_category,
  canonical_symbol,
  timeframe,
  table_name,
  status,
  issue_count,
  result_summary,
  execution_duration_ms
FROM quality_data_validation
WHERE env_name = 'PROD'
  AND run_timestamp >= NOW() - INTERVAL '24 hours'
  AND ($1::text IS NULL OR canonical_symbol = $1)  -- symbol filter
  AND ($2::text IS NULL OR timeframe = $2)         -- timeframe filter
  AND ($3::text IS NULL OR validation_type = $3)   -- type filter
  AND ($4::text IS NULL OR check_category = $4)    -- category filter
ORDER BY run_timestamp DESC
LIMIT 100;
```

**Widget Display:**
```
┌─────────────────────────────────────────────────────────────┐
│ Filters:                                                    │
│ Symbol: [DXY ▾]  Timeframe: [1m ▾]  Type: [All ▾]         │
│ Category: [dxy_components ▾]  Status: [All ▾]             │
├─────────────────────────────────────────────────────────────┤
│ Time       │ Category        │ Status │ Issues │ Details   │
├────────────┼─────────────────┼────────┼────────┼───────────┤
│ 10:03 AM   │ dxy_components  │ ✅ Pass│   0    │ View →   │
│ 09:48 AM   │ dxy_components  │ ✅ Pass│   0    │ View →   │
│ 09:33 AM   │ dxy_components  │ ⚠️ Warn│   2    │ View →   │
│ 09:18 AM   │ dxy_components  │ ❌ Crit│  12    │ View →   │
└─────────────────────────────────────────────────────────────┘
```

---

#### Widget 4: Drill-Down to JSONB Details

**Purpose:** Click any validation result to see full `result_summary` and `issue_details` JSONB

**Query:**
```sql
-- Fetch single validation result with full details
SELECT 
  id,
  run_id,
  run_timestamp,
  validation_type,
  check_category,
  canonical_symbol,
  timeframe,
  table_name,
  window_start,
  window_end,
  status,
  severity_gate,
  issue_count,
  result_summary,      -- Full JSONB
  issue_details,       -- Full JSONB (sampled)
  threshold_config,
  worker_version,
  execution_duration_ms
FROM quality_data_validation
WHERE id = $1;       -- Single result ID
```

**Widget Display (Drill-Down Modal):**
```
┌─────────────────────────────────────────────────────────────┐
│ Validation Details                                    [✕]   │
├─────────────────────────────────────────────────────────────┤
│ Run ID: 550e8400-e29b-41d4-a716-446655440000               │
│ Time: 2026-01-14 09:18:00 UTC                              │
│ Check: dxy_components (data_bars/1m)                       │
│ Status: ❌ CRITICAL                                         │
│ Duration: 2.3s                                             │
├─────────────────────────────────────────────────────────────┤
│ Summary:                                                   │
│ {                                                          │
│   "total_dxy_bars": 180,                                   │
│   "bars_with_missing_components": 12,                     │
│   "coverage_percentage": 93.33,                           │
│   "missing_components": ["USDSEK", "USDCHF"]              │
│ }                                                          │
├─────────────────────────────────────────────────────────────┤
│ Issues (12 samples):                                       │
│ [                                                          │
│   {                                                        │
│     "ts_utc": "2026-01-14T09:15:00Z",                    │
│     "available_components": 4,                            │
│     "found_components": ["EURUSD","USDJPY","GBPUSD",..] │
│   },                                                       │
│   { ... }                                                  │
│ ]                                                          │
└─────────────────────────────────────────────────────────────┘
```

---

#### Widget 5: DXY-Specific Health Dashboard

**Purpose:** Dedicated view for DXY quality (critical asset)

**Query:**
```sql
-- DXY health summary (last 24 hours)
WITH dxy_checks AS (
  SELECT 
    check_category,
    timeframe,
    table_name,
    status,
    issue_count,
    result_summary,
    run_timestamp,
    ROW_NUMBER() OVER (
      PARTITION BY check_category, timeframe 
      ORDER BY run_timestamp DESC
    ) as rn
  FROM quality_data_validation
  WHERE canonical_symbol = 'DXY'
    AND run_timestamp >= NOW() - INTERVAL '24 hours'
)
SELECT 
  check_category,
  timeframe,
  table_name,
  status,
  issue_count,
  result_summary,
  run_timestamp
FROM dxy_checks
WHERE rn = 1  -- Latest only
ORDER BY 
  CASE timeframe 
    WHEN '1m' THEN 1 
    WHEN '5m' THEN 2 
    WHEN '1h' THEN 3 
    ELSE 4 
  END,
  check_category;
```

**Widget Display:**
```
┌─────────────────────────────────────────────────────────────┐
│ DXY (Dollar Index) Health Monitor                          │
├─────────────────────────────────────────────────────────────┤
│ 1m Data (data_bars):                                       │
│   ✅ Freshness:             0 issues (last check: 2m ago)  │
│   ✅ Duplicates:            0 issues                        │
│   ✅ OHLC Integrity:        0 issues                        │
│   ✅ Component Availability: 100% coverage (6/6 pairs)     │
│                                                            │
│ 5m Data (derived_data_bars):                               │
│   ✅ Freshness:             0 issues                        │
│   ✅ Alignment:             0 misaligned bars               │
│   ⚠️  Aggregation Quality:  3 partial buckets (score=1)   │
│                                                            │
│ 1h Data (derived_data_bars):                               │
│   ✅ Freshness:             0 issues                        │
│   ✅ Alignment:             0 misaligned bars               │
│   ✅ Aggregation Quality:   0 issues                        │
└─────────────────────────────────────────────────────────────┘
```

---

#### Widget 6: Per-Asset Quality Scorecard

**Purpose:** Show quality metrics per canonical_symbol

**Query:**
```sql
-- Asset quality scorecard (last 24 hours)
WITH latest_checks AS (
  SELECT DISTINCT ON (canonical_symbol, check_category)
    canonical_symbol,
    check_category,
    status,
    issue_count,
    run_timestamp
  FROM quality_data_validation
  WHERE env_name = 'PROD'
    AND canonical_symbol IS NOT NULL
    AND run_timestamp >= NOW() - INTERVAL '24 hours'
  ORDER BY canonical_symbol, check_category, run_timestamp DESC
)
SELECT 
  canonical_symbol,
  COUNT(*) FILTER (WHERE status = 'pass') as passed_checks,
  COUNT(*) FILTER (WHERE status = 'warning') as warning_checks,
  COUNT(*) FILTER (WHERE status = 'critical') as critical_checks,
  COUNT(*) FILTER (WHERE status = 'error') as error_checks,
  COUNT(*) as total_checks,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'pass') / COUNT(*), 2) as health_score
FROM latest_checks
GROUP BY canonical_symbol
ORDER BY health_score ASC, canonical_symbol;
```

**Widget Display:**
```
┌─────────────────────────────────────────────────────────────┐
│ Asset Quality Scorecard                                    │
├──────────┬────────┬──────────┬──────────┬───────┬──────────┤
│ Symbol   │ Health │ Pass     │ Warning  │ Crit  │ Error    │
├──────────┼────────┼──────────┼──────────┼───────┼──────────┤
│ USDSEK   │  75.0% │    6/8   │    2     │   0   │    0     │
│ USDCHF   │  87.5% │    7/8   │    1     │   0   │    0     │
│ EURUSD   │ 100.0% │    8/8   │    0     │   0   │    0     │
│ USDJPY   │ 100.0% │    8/8   │    0     │   0   │    0     │
│ DXY      │  90.0% │   9/10   │    1     │   0   │    0     │
│ GBPUSD   │ 100.0% │    8/8   │    0     │   0   │    0     │
└──────────┴────────┴──────────┴──────────┴───────┴──────────┘
```

---

**Deliverables:**
- Dashboard query specifications (above 6 widgets)
- SQL queries ready for dashboard integration
- Widget mockups (ASCII art + descriptions)
- Data access patterns documented
- Future: Implement actual dashboard UI (Grafana, React, etc.)

---

### Phase 6: Testing & Deployment (Week 4-5)
**Duration:** 5-7 days

**Testing Strategy:**

1. **Unit Tests** (Jest)
   ```typescript
   // tests/validations/freshnessCheck.test.ts
   describe('Freshness Check', () => {
     it('should flag staleness > 15 minutes as critical', async () => {
       // Mock DB with stale data
       // Run check
       // Assert critical status
     });
     
     it('should pass when data is fresh', async () => {
       // Mock DB with fresh data
       // Run check
       // Assert pass status
     });
   });
   ```

2. **Integration Tests** (Staging DB)
   - Test against real staging database
   - Inject known issues and verify detection
   - Test all validation categories

3. **Load Testing**
   - Verify worker can complete within execution limits (30s/request)
   - Test with full asset list (~50-100 symbols)
   - Optimize queries if needed

4. **Staging Deployment**
   ```bash
   # Deploy to staging
   wrangler deploy --env staging
   
   # Manually trigger validations
   curl https://data-quality-validator-staging.distortsignals.workers.dev/validate?type=hourly
   
   # Verify results in DB
   psql -c "SELECT * FROM quality_data_validation ORDER BY run_timestamp DESC LIMIT 10;"
   ```

5. **Production Deployment**
   ```bash
   # Deploy to production with cron disabled initially
   wrangler deploy --env production
   
   # Enable cron triggers after manual testing
   wrangler triggers update --env production
   ```

**Deliverables:**
- Comprehensive test suite
- Staging validation
- Production deployment
- Runbook documentation

---

## Data Storage Strategy

### Result Storage Design

**Efficiency Considerations:**
- Store high-level summary per check category
- Sample detailed issues (max 100 records per check)
- Use JSONB for flexibility
- Compress large result sets

**Example Result Record:**
```json
{
  "run_id": "550e8400-e29b-41d4-a716-446655440000",
  "run_timestamp": "2026-01-14T10:00:00Z",
  "validation_type": "phase_a_active",
  "check_category": "freshness",
  "canonical_symbol": null,
  "timeframe": "1m",
  "table_name": "data_bars",
  "window_start": "2026-01-07T10:00:00Z",
  "window_end": "2026-01-14T10:00:00Z",
  "status": "warning",
  "issue_count": 3,
  "result_summary": {
    "total_assets_checked": 47,
    "stale_assets": 3,
    "max_staleness_minutes": 8.5,
    "avg_staleness_minutes": 2.1,
    "warning_count": 3,
    "critical_count": 0
  },
  "issue_details": [
    {
      "canonical_symbol": "EURUSD",
      "latest_bar": "2026-01-14T09:51:30Z",
      "staleness_minutes": 8.5,
      "severity": "warning"
    },
    {
      "canonical_symbol": "GBPUSD",
      "latest_bar": "2026-01-14T09:53:00Z",
      "staleness_minutes": 7.0,
      "severity": "warning"
    },
    {
      "canonical_symbol": "USDJPY",
      "latest_bar": "2026-01-14T09:54:00Z",
      "staleness_minutes": 6.0,
      "severity": "warning"
    }
  ],
  "threshold_config": {
    "warning_minutes": 5,
    "critical_minutes": 15
  },
  "worker_version": "1.0.0",
  "execution_duration_ms": 2345
}
```

### Retention Policy

```sql
-- Implement retention policy via scheduled job or trigger
-- Keep detailed records for 90 days
DELETE FROM quality_data_validation
WHERE run_timestamp < NOW() - INTERVAL '90 days'
  AND check_category NOT IN ('freshness', 'dxy_components'); -- Keep critical checks longer

-- Archive to cold storage (optional)
-- Copy to S3/GCS before deletion for long-term analysis
```

---

## HARD_FAIL Operational Behavior (Minimal Alerting)

You don't want a full alerting system, but you do need defined operational response for architecture gates.

### Mandatory HARD_FAIL Handling

**Every HARD_FAIL gate failure must:**

1. **Always write to quality_data_validation:**
   ```json
   {
     "run_id": "...",
     "status": "HARD_FAIL",
     "severity_gate": "HARD_FAIL",
     "check_category": "architecture_gate",
     "issue_count": 127,
     ...
   }
   ```

2. **Worker returns non-success for observability:**
   - Return HTTP 206 (Partial Content) or 418 (I'm a teapot) if HARD_FAIL detected
   - Log explicit HARD_FAIL marker: `[{runId}] HARD_FAIL: derived_has_1m_rows=127`
   - CloudFlare logs capture this for ops visibility

3. **Single Slack webhook for HARD_FAIL only (optional but recommended):**
   ```
   :red_circle: HARD_FAIL: architecture_gate detected 127 1m rows in derived_data_bars
   Run ID: 550e8400-e29b-41d4-a716-446655440000
   Env: PROD | Time: 2026-01-14T10:03:45Z
   Action: Check dashboard, investigate ingestion/aggregation worker
   ```
   (This is minimal—one Slack message per HARD_FAIL, no other channels.)

4. **Ops checks dashboard query hourly (if no Slack):**
   If you want zero notifications, add this to ops daily standup checklist:
   ```sql
   SELECT * FROM quality_data_validation
   WHERE severity_gate = 'HARD_FAIL' AND run_timestamp >= NOW() - INTERVAL '1 hour'
   ORDER BY run_timestamp DESC;
   ```
   **Action:** If any rows, investigate immediately (do not ingest during corruption).

### HARD_FAIL Non-Negotiable Rules

- **HARD_FAIL always blocks further processing** in the validation suite
- Do not attempt to continue validations after architecture gate failure
- Return early, log failure, store failure record, notify ops
- No silent HARD_FAIL (must be visible in logs + dashboard)

---

## Weekly Deep Performance Risk & Tuning

Weekly deep scans (gap density, coverage, historical integrity) can be expensive on large datasets.

### Start Conservative, Profile, Expand

**Week 1 (Initial):**
```typescript
WEEKLY_DEEP: {
  cron: '0 4 * * 0',  // Sunday 4 AM UTC
  windowWeeks: 4,     // START with 4 weeks only
  maxExecutionTime: 28000,  // 28s budget
}
```

**Week 2+ (After profiling):**
1. Review execution_duration_ms in quality_data_validation
2. If avg < 15s: expand windowWeeks to 8, then 12
3. If avg > 20s: reduce sample_size or add downgrade strategy

### Downgrade Strategy (If Performance Degraded)

If any RPC exceeds 8s:
```typescript
// Reduce window + sample
window_weeks = Math.max(2, Math.ceil(window_weeks * 0.5));
sample_size = Math.max(1000, Math.ceil(sample_size * 0.75));

// Log and retry
logger.warn(`RPC timeout risk. Downgraded to ${window_weeks}w, ${sample_size} samples`);
```

### Store Timing Breakdown

Modify quality_validation_runs to include RPC timings:
```json
{
  "run_id": "...",
  "rpc_timings_ms": {
    "rpc_check_staleness": 1200,
    "rpc_check_duplicates": 800,
    "rpc_check_gap_density": 5400,  // Slowest
    "rpc_check_coverage_ratios": 2100,
    "rpc_check_historical_integrity_sample": 7500
  },
  "total_execution_ms": 17000,
  "slowest_rpc": "rpc_check_historical_integrity_sample"
}
```

**Action:** If slowest_rpc > 8s, trigger downgrade on next run.

---

## DXY Component Tolerance Policy (Explicit Thresholds)

The DXY component validation (RPC 4) depends on feed quality. Define tolerance upfront to avoid surprise failures.

### Three Tolerance Modes

**Strict Mode (6/6 required):**
```
6/6 components → pass
5/6 components → warning (or error, your choice)
≤4/6 components → critical
```
Use if DXY data source is reliable.

**Degraded Mode (5/6 acceptable):**
```
6/6 components → pass (100%)
5/6 components → warning (degraded, ~83%)
4/6 components → critical (~67%)
≤3/6 components → critical
```
Use if occasional component gaps expected but rare.

**Lenient Mode (3/6 minimum):**
```
6/6 components → pass (100%)
5/6 components → pass (~83%)
4/6 components → warning (~67%)
3/6 components → warning (~50%)
≤2/6 components → critical
```
Use if multiple component gaps are systemic (not recommended).

### Configuration

```typescript
export const DXY_COMPONENT_CONFIG = {
  tolerance_mode: 'strict' | 'degraded' | 'lenient',  // Set once, document reason
  strict: {
    pass: [6],
    warning: [5],
    critical: [0, 1, 2, 3, 4],
  },
  degraded: {
    pass: [6, 5],
    warning: [4],
    critical: [0, 1, 2, 3],
  },
  lenient: {
    pass: [6, 5, 4],
    warning: [3],
    critical: [0, 1, 2],
  },
};
```

### Rationale for Choice

**Document in comments:**
```
// DXY tolerance mode: 'degraded'
// Reason: USDSEK feed has occasional gaps (Wed 12-14 UTC), 
// but full 6/6 recovery by EOD. Treating 5/6 as acceptable 
// to avoid false alerts.
// Review: quarterly, after 1000+ DXY validation runs
```

---

## Migration & Cutover Plan (Parallel Run + Validation)

Reduce risk by running Python + Worker in parallel for 7 days before cutover.

### Week -1: Parallel Execution (7 days)

**Setup:**
1. Deploy data-quality-validator Worker to staging (cron disabled)
2. Keep existing Python script running in production
3. Manually trigger Worker to create baseline data

**Daily comparison:**
```sql
-- Compare Python results vs Worker results (same day)
WITH python_results AS (
  SELECT check_category, table_name, timeframe, issue_count, status
  FROM python_validation_results  -- Existing Python table
  WHERE run_timestamp >= NOW() - INTERVAL '1 day'
),
worker_results AS (
  SELECT check_category, table_name, timeframe, issue_count, status
  FROM quality_data_validation
  WHERE env_name = 'STAGING' AND run_timestamp >= NOW() - INTERVAL '1 day'
)
SELECT 
  COALESCE(p.check_category, w.check_category) as category,
  p.issue_count as python_issues,
  w.issue_count as worker_issues,
  ABS(p.issue_count - w.issue_count) as diff,
  CASE WHEN p.status = w.status THEN 'MATCH' ELSE 'MISMATCH' END as status_match
FROM python_results p
FULL OUTER JOIN worker_results w
  ON p.check_category = w.check_category
  AND p.table_name = w.table_name
  AND p.timeframe = w.timeframe
WHERE ABS(p.issue_count - w.issue_count) > 5  -- Flag differences > 5 issues
ORDER BY diff DESC;
```

**Success criteria:**
- Same check_category results
- issue_count within ±5% (or absolute difference < 5)
- Status agreement (pass/warning/critical)
- No HARD_FAIL in Worker that Python didn't detect

### Cutover Checklist (Day 8)

- [ ] 7 days parallel execution complete
- [ ] Comparison query shows <5% variance
- [ ] HARD_FAIL behavior tested and approved
- [ ] Slack webhook tested (if using minimal alerting)
- [ ] Dashboard queries verified against live data
- [ ] Ops trained on HARD_FAIL response
- [ ] Rollback procedure documented (see below)
- [ ] Cutover scheduled for low-volume time (e.g., Sunday 2 AM)

**Cutover actions:**
1. Disable Python cron job
2. Enable Worker cron job (quick_health, daily, weekly)
3. Monitor dashboard for first 24h
4. Document final issue_count baseline

### Rollback Plan (If Issues Detected Post-Cutover)

**If Worker produces HARD_FAIL within 1 hour of cutover:**
1. Disable Worker cron immediately
2. Re-enable Python job
3. Investigate HARD_FAIL root cause (likely gate trigger false positive)
4. Post-mortem before re-enabling Worker

**If Worker misses critical issues:**
1. Re-enable Python job (parallel run for 1 week)
2. Review missing-issue logic in Worker RPC
3. Fix, re-test, re-deploy

**Expected timeline:** Rollback < 5 min via cron disable.

---



### 5m Derived Aggregation Rules

**Quality-Score Model (Mandatory):**
```
5 source 1m bars → quality_score = 2 (complete)
4 source 1m bars → quality_score = 1 (partial)
3 source 1m bars → quality_score = 0 (minimal)
< 3 source 1m bars → DERIVED BAR MUST NOT EXIST (hard fail)
```

**For Non-DXY 5m Bars:**
1. Sample a 5m bucket (e.g., 2026-01-14 09:00:00–09:05:00 UTC)
2. Count source 1m bars in data_bars WHERE canonical_symbol='EURUSD' AND timeframe='1m' AND ts_utc IN [09:00, 09:01, 09:02, 09:03, 09:04]
3. If bar_count < 3 → verify NO row exists in derived_data_bars for this bucket
4. If bar_count >= 3 → verify row EXISTS in derived_data_bars
5. **OHLC Reconciliation:**
   - Compute: agg_open = first 1m bar open, agg_high = max(high), agg_low = min(low), agg_close = last 1m bar close
   - Compare to stored OHLC in derived_data_bars within epsilon:
     - high/low: relative tolerance 1e-4 + absolute tolerance 1e-6
     - open/close: relative tolerance 1e-4
   - Flag if computed != stored (data corruption)
6. Store quality_score in result_summary for operational visibility

**For DXY 5m Bars (Same Rules):**
- Query DXY 1m source from data_bars (NOT derived_data_bars)
- Apply same quality-score logic
- Quality depends on component availability (RPC 4)

### 1h Derived Aggregation Rules

**Recommended: Quality-Score for 1h (Not Strict Bar Count)**
```
12 source 5m bars → quality_score = 2 (complete hour)
9–11 source 5m bars → quality_score = 1 (partial hour, 75–92%)
6–8 source 5m bars → quality_score = 0 (minimal, 50–75%)
< 6 source 5m bars → DERIVED BAR MUST NOT EXIST (hard fail)
```

Alternative (if stricter): Require all 12 5m bars for 1h to exist (no quality-score, just pass/fail).

**1h Aggregation Validation:**
1. Sample a 1h bucket (e.g., 2026-01-14 09:00–10:00 UTC)
2. Count source 5m bars in derived_data_bars WHERE canonical_symbol='EURUSD' AND timeframe='5m' AND ts_utc IN [09:00, 09:05, 09:10, ..., 09:55]
3. If bar_count < 6 → verify NO row exists in derived_data_bars for 1h
4. If bar_count >= 6 → verify row EXISTS
5. **OHLC Reconciliation:** Same as 5m (compute from 5m source, compare to stored 1h)
6. Store quality_score in result_summary

### DXY-Specific Notes

**Data Flow:**
```
Component FX pairs (EURUSD, USDJPY, GBPUSD, USDCAD, USDSEK, USDCHF)
  ↓ (all in data_bars, timeframe='1m')
DXY 1m computation
  ↓ (writes to data_bars, canonical_symbol='DXY', timeframe='1m')
DXY 1m in data_bars
  ↓ (aggregated by aggregator worker)
DXY 5m/1h/1d in derived_data_bars
```

**RPC 4 Output (Component Availability):**
- DXY 1m quality depends on all 6 components being available in data_bars at matching timestamps
- If any component missing → quality score for that DXY 1m bar degrades (but bar can still aggregate to 5m if bar_count >= 3)
- Flagged in RPC 4 output for ops attention (DXY quality, not aggregation rule violation)

**RPC 5 Output (Aggregation Reconciliation):**
- Includes DXY 5m/1h bars in sample
- Uses same quality-score model as non-DXY symbols
- Reconciliation failures indicate data corruption or missing source bars

---

## Configuration Management

### Environment Variables

```toml
# wrangler.toml
[env.production]
name = "data-quality-validator"
compatibility_date = "2024-01-01"

[env.production.vars]
WORKER_VERSION = "1.0.0"
LOG_LEVEL = "info"

# Thresholds
STALENESS_WARNING_MINUTES = "5"
STALENESS_CRITICAL_MINUTES = "15"
PRICE_JUMP_THRESHOLD = "0.10"

# Notification endpoints
SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/..."
PAGERDUTY_API_KEY = "..."

[[env.production.hyperdrive]]
binding = "HYPERDRIVE"
id = "your-hyperdrive-id"

[env.staging]
name = "data-quality-validator-staging"
# ... similar config with staging-specific values
```

### Database Connection

**⚠️ MANDATORY: Use Hyperdrive (Direct Postgres), NOT Supabase REST**

This is non-negotiable for performance:

```typescript
// src/db/client.ts
// CORRECT: Direct Postgres via Hyperdrive
import { PostgresClient } from '@cloudflare/workers-types';

export function createDbClient(env: Env): DatabaseClient {
  return env.HYPERDRIVE.connect();  // 1 RPC = 1 DB roundtrip
}

// INCORRECT: Do NOT use
// const client = new SupabaseClient(rest_url, api_key);  // ❌ Subrequest overhead
```

**Why Hyperdrive is mandatory:**
- Quick health: 3 RPCs × 15 min (1440 runs/week) = 4,320 Postgres connections
- Daily: 6 RPCs × 7 runs/week = 42 connections
- Weekly: 3 RPCs × 1 run/week = 3 connections
- **Total: ~4,400 connections/week**
- Hyperdrive pooling handles this efficiently
- Supabase REST = 4,400 subrequest limits (blocked)

**wrangler.toml:**
```toml
[[env.production.hyperdrive]]
binding = "HYPERDRIVE"
id = "your-hyperdrive-id-from-cloudflare"

# Verify in worker init
const db = env.HYPERDRIVE.connect();
const result = await db.query("SELECT 1");  // Should succeed
```

**Test in staging first:**
```bash
wrangler deploy --env staging
curl https://data-quality-validator-staging.distortsignals.workers.dev/test-db
# Expected: "Hyperdrive connection OK"
```

---



---

## Operational Considerations

### 1. Performance Optimization

**Query Optimization:**
- Use appropriate indexes on `data_bars` and `derived_data_bars`
- Limit result sets (TOP N per check, sample issues)
- Consider materialized views for expensive aggregations
- Use connection pooling (Hyperdrive)

**Execution Time Management:**
- Split large validations into chunks
- Use `ctx.waitUntil()` for async storage
- Monitor and optimize slow queries

**Example Optimization:**
```typescript
// Instead of checking all assets at once, batch them
async function runValidationsInBatches(
  assets: string[],
  batchSize: number = 10
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  
  for (let i = 0; i < assets.length; i += batchSize) {
    const batch = assets.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(asset => runValidation(asset))
    );
    results.push(...batchResults);
  }
  
  return results;
}
```

### 2. Error Handling & Retry Logic

```typescript
async function runValidationWithRetry(
  validation: ValidationFn,
  maxRetries: number = 3
): Promise<ValidationResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await validation();
    } catch (error) {
      console.error(`Validation failed (attempt ${attempt}/${maxRetries}):`, error);
      
      if (attempt === maxRetries) {
        // Return error result instead of throwing
        return {
          checkCategory: validation.name,
          status: 'error',
          issueCount: 0,
          resultSummary: { error: error.message },
          issueDetails: []
        };
      }
      
      // Exponential backoff
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }
}
```

### 3. Cost Optimization

**Worker Execution Costs:**
- Minimize worker invocations by consolidating checks
- Use appropriate cron schedules (not too frequent)
- Optimize query performance to reduce execution time

**Database Costs:**
- Limit query result sizes
- Use indexes effectively
- Consider read replicas for heavy validation queries

**Storage Costs:**
- Implement aggressive retention policies
- Archive to cheaper storage (S3/GCS) after 90 days
- Compress large JSONB fields

### 4. Logging & Debugging

```typescript
// src/utils/logger.ts
export class Logger {
  constructor(
    private runId: string,
    private logLevel: string
  ) {}
  
  info(message: string, data?: any) {
    console.log(`[${this.runId}] INFO: ${message}`, data);
  }
  
  error(message: string, error: any) {
    console.error(`[${this.runId}] ERROR: ${message}`, {
      error: error.message,
      stack: error.stack,
      ...error
    });
  }
  
  metric(name: string, value: number, tags?: Record<string, string>) {
    // Send to monitoring system (Datadog, CloudWatch, etc.)
    console.log(`[${this.runId}] METRIC: ${name}=${value}`, tags);
  }
}
```

---

## Testing Strategy Summary

## Worker Health Monitoring (Addendum)

### Objectives
- Detect if workers are alive, measure execution duration, and capture errors without depending on validation RPCs.
- Provide a stable dashboardable source that remains useful even if ops tables change.
- Standardize status semantics and make runs idempotent so retries do not duplicate rows.

### Tables to Add
- **quality_workerhealth** (append-only; one row per run per worker)
  - Columns: `id BIGSERIAL PK`, `env_name TEXT NOT NULL`, `worker_name TEXT NOT NULL` (e.g., ingestion, aggregation), `run_id UUID NOT NULL` (idempotency key generated per invocation), `run_ts TIMESTAMPTZ NOT NULL DEFAULT now()`, `scheduled_for_ts TIMESTAMPTZ`, `status TEXT NOT NULL` (enum: pass|warning|critical|error), `duration_ms INT`, `last_success_ts TIMESTAMPTZ`, `last_error_ts TIMESTAMPTZ`, `error_count INT`, `error_samples JSONB` (top N strings/codes), `metrics JSONB` (rows_written, assets_processed, http_429, cpu_ms, etc.).
  - Indexes: `(env_name, worker_name, run_ts DESC)`, `(env_name, worker_name, status, run_ts DESC)`, `UNIQUE(env_name, worker_name, run_id)` (prevents duplicate rows on retries/double triggers).

- **ops_issues** (append-only; structured error/warning events)
  - Columns: `id BIGSERIAL PK`, `env_name TEXT`, `worker_name TEXT`, `severity TEXT` (info|warning|error|critical), `event_ts TIMESTAMPTZ DEFAULT now()`, `code TEXT` (CPU_LIMIT, TIMEOUT, RPC_FAIL, HTTP_429, etc.), `message TEXT`, `context JSONB` (request id, endpoint, retry count, asset, checkpoint state, etc.).
  - Indexes: `(env_name, worker_name, event_ts DESC)`, `(env_name, worker_name, severity, event_ts DESC)`, `(code, event_ts DESC)`.
  - Retention: keep 30–180 days, then prune.

### Status Enum & Rule (use everywhere)
- Enum: `pass | warning | critical | error` (or `success | warning | error`; choose one set and keep consistent)
- Rule:
  - pass/success: run completed, all checkpoints true, no errors
  - warning: run completed but partial failures or degraded metrics
  - critical/error: did not reach finished checkpoint OR repeated failures OR `last_success_ts` too old

### Worker Responsibilities (per cron run)
- Generate `run_id` (UUID) at start; include `scheduled_for_ts` if cron provides it.
- Measure `duration_ms` and decide `status` using the enum rule above.
- Maintain `last_success_ts` / `last_error_ts` and `error_count` within the run.
- Write **one** row to `quality_workerhealth` at the end of each run (ingestion and aggregation workers); rely on `UNIQUE(env_name, worker_name, run_id)` for idempotency on retries.
- Log exceptions/warnings to `ops_issues` with code/message/context (capture retries/429s, timeouts, checkpoints reached).

### Checkpoints & Metrics JSON
- Include booleans for checkpoints: `{ started, fetched, upserted, finished }` to spot “stuck mid-run”.
- Include per-step timings (e.g., `rpc_timings_ms`), counts (`assets_total`, `assets_ok`, `assets_failed`), HTTP retry info (`http_429`, `retry_after_ms`), and any CPU/timeout signals.

### Dashboard Widgets (minimum)
- For each worker: **latest state** (last health row) and **rolling window** (1h/24h success rate) to avoid stale “green” while recent runs failed.
- Ingestion: last run age, last success age, 24h success rate, last error snippet.
- Aggregation: same as ingestion, plus rows processed trend.
- Errors last 60 minutes: group by `code` from `ops_issues`.

### Optional RPC
- `rpc_get_worker_health_summary(env_name, worker_name, window_minutes)` returning last N rows aggregated for dashboards. Not required to start; direct SELECTs over `quality_workerhealth` are fine.

### Alerts (optional initial scope)
- Slack/page when: no run in X minutes, no recent success, HARD_FAIL (architecture gate), or repeated worker failures.

### Retention & Janitor
- Enforce retention via a scheduled janitor (DB cron/ops-janitor worker), not manual deletes.
- Defaults: `quality_workerhealth` keep 30–90 days (pick one; recommendation: 90d). `ops_issues` keep 30–180 days (recommend 180d).

### Worker Changes Required (ingestion & aggregation)
- Add a run envelope: `run_id`, `started_at`, `scheduled_for_ts`, `env_name`, `worker_name`, `trigger` (cron/manual).
- At end (finally): write one health row with status, duration_ms, checkpoints, metrics; let the UNIQUE(run_id, env, worker) prevent duplicates on retries.
- On any exception: insert into `ops_issues` with severity, code, message, context (stack/request id/asset/step).
- This is a small targeted change; both ingestion and aggregation should emit health + errors for consistent dashboards.


### Unit Tests
- ✅ Each validation function with mocked DB
- ✅ Alert logic
- ✅ Result storage
- ✅ Configuration parsing

### Integration Tests
- ✅ Full validation runs against staging DB
- ✅ Scheduled trigger simulation
- ✅ End-to-end result storage
- ✅ Alert notification delivery

### Manual Testing Checklist
- [ ] Deploy to staging
- [ ] Manually trigger each validation type
- [ ] Verify results in `quality_data_validation` table
- [ ] Inject known data issues and verify detection
- [ ] Monitor worker execution time and resource usage
- [ ] Test DXY-specific validations
- [ ] Verify retention policy

### Load Testing
- [ ] Test with all active assets (~50-100 symbols)
- [ ] Verify execution completes within 30s limit
- [ ] Test concurrent cron triggers
- [ ] Monitor database connection pool usage

---

## Deliverables Checklist

### Phase 1: Database Schema & RPCs
- [ ] Migration file: `XXX_create_quality_validation_tables.sql` (schema only)
- [ ] Migration file: `XXX_create_quality_validation_rpcs.sql` (9 RPC functions)
- [ ] Retention policy implementation
- [ ] Indexes verified
- [ ] Each RPC tested in Supabase editor
- [ ] Performance benchmarked

### Phase 2: Core Worker
- [ ] Worker project structure
- [ ] `wrangler.toml` configuration
- [ ] Database client and connection handling
- [ ] Entry point with scheduled & fetch handlers
- [ ] Result storage implementation

### Phase 3: RPC Suite
- [ ] rpc_check_staleness
- [ ] rpc_check_architecture_gates
- [ ] rpc_check_duplicates
- [ ] rpc_check_dxy_components
- [ ] rpc_check_aggregation_reconciliation_sample
- [ ] rpc_check_ohlc_integrity_sample
- [ ] rpc_check_gap_density
- [ ] rpc_check_coverage_ratios
- [ ] rpc_check_historical_integrity_sample

### Phase 4: Scheduling
- [ ] Cron configuration (4 schedules)
- [ ] Schedule-to-validation mapping
- [ ] Manual trigger endpoint
- [ ] Results query endpoint

### Phase 5: Dashboard
- [ ] Widget 1: Latest Status Board
- [ ] Widget 2: Trend Charts (7-day history)
- [ ] Widget 3: Quick Filters (symbol, timeframe, category)
- [ ] Widget 4: Drill-Down to JSONB Details
- [ ] Widget 5: DXY-Specific Health Monitor
- [ ] Widget 6: Per-Asset Quality Scorecard

### Phase 6: Testing & Deployment
- [ ] Unit test suite
- [ ] Integration tests
- [ ] Staging deployment
- [ ] Production deployment
- [ ] Monitoring dashboard
- [ ] Runbook documentation

---

## Timeline Summary

| Phase | Duration | Key Milestones |
|-------|----------|----------------|
| Phase 1: Database Schema & RPCs | 4-5 days | ✅ Schema + 9 RPCs deployed to staging |
| Phase 2: Core Worker Setup | 4-5 days | ✅ Skeleton worker with DB connection |
| Phase 3: RPC Implementation | 7-10 days | ✅ All 9 RPCs tested & benchmarked |
| Phase 4: Scheduling | 3-4 days | ✅ Cron schedules configured, offset verified |
| Phase 5: Dashboard Specs | 3-4 days | ✅ 6 widget queries documented |
| Phase 6: Testing & Deployment | 5-7 days | ✅ Production deployment complete |
| **Total** | **26-35 days** | **~3-4 weeks** |

---

## Success Criteria

### Technical Success
- ✅ All validations from Python scripts ported to TypeScript
- ✅ Worker executes on schedule without errors
- ✅ Results stored correctly in `quality_data_validation` table
- ✅ Alerts triggered and delivered for critical issues
- ✅ DXY-specific validations operational
- ✅ Execution time < 30s per run
- ✅ No database connection issues

### Business Success
- ✅ Data quality issues detected within 5 minutes
- ✅ Historical trends visible in validation results
- ✅ Reduced manual validation effort (from daily Python runs to automated)
- ✅ Faster incident response via automated alerting
- ✅ DXY quality guaranteed for downstream systems

---

## Future Enhancements (Post-MVP)

### Phase 7: Advanced Analytics (Future)
- Trend analysis (quality degradation over time)
- Predictive alerting (ML-based anomaly detection)
- Asset health scoring
- Custom validation rules via API

### Phase 8: Self-Healing (Future)
- Automatic data correction for certain issue types
- Re-aggregation triggers when coverage issues detected
- Component data backfill for DXY gaps

### Phase 9: Public Dashboard (Future)
- Real-time data quality dashboard
- Historical quality metrics
- Per-asset quality scores
- SLA tracking

---

## Questions for Discussion

1. **1h Aggregation Rules:** Strict (all 12 5m bars required) or quality-score based (like 5m)?
2. **DXY Component Tolerance:** Which mode? (strict: 6/6 only, degraded: 5/6 acceptable, lenient: 3/6 minimum)
3. **HARD_FAIL Notification:** Slack webhook for HARD_FAIL gate failures, or check dashboard manually?
4. **Hyperdrive Setup:** Confirm Hyperdrive pool ID and staging/prod configs locked in before Phase 1?
5. **Weekly Deep Tuning:** Start with 4-week window? Profiling cadence (daily, weekly)?
6. **Validation Frequency:** Are offset cron schedules (3,18,33,48) appropriate for your ingestion/aggregation windows?
7. **Retention Policy:** Is 90 days detailed + cleanup sufficient?
8. **Parallel Cutover:** Approve 7-day Python + Worker parallel run before cutover (risk reduction)?
9. **Dashboard Platform:** Grafana, Metabase, custom React, or direct SQL queries?
10. **Cost Budget:** Monthly cost target for worker + Postgres queries via Hyperdrive?
11. **Testing Window:** How much time for staging before production deployment?

---

## References

- Existing validation scripts: `/scripts/verify_data.py`, `/scripts/diagnose_staleness.py`
- Database schema: `/db/migrations/`
- Cloudflare Workers documentation: https://developers.cloudflare.com/workers/
- Hyperdrive (Postgres pooling): https://developers.cloudflare.com/hyperdrive/

---

**Document Version:** 1.0  
**Last Updated:** 2026-01-14  
**Author:** GitHub Copilot  
**Status:** Draft for Review
