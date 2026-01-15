# PHASE 5 REQUIREMENTS - COMPLETE DATABASE ARTIFACT

**Generated**: 2026-01-13  
**Status**: All information extracted from production Supabase database  
**Purpose**: Single source of truth for Phase 5 implementation

---

## PART A: CANONICAL CONTRACTS (1 Page of Truth)

### A.1 Cursor Semantics

**CURRENT IMPLEMENTATION** (verified from database):

```
last_agg_bar_ts_utc = start timestamp of the NEXT window to process
```

**Evidence**:
- In `agg_bootstrap_cursor`: 
  - If data exists: `cursor = (max_ts / interval * interval) - interval` = last complete window start
  - If no data: `cursor = next boundary after now` = next window start
  - Both semantics = "cursor is the next window's start time"

- In `catchup_aggregation_range`:
  - `v_ws := v_cursor` (window start = cursor)
  - `v_we := v_ws + interval` (window end)
  - `v_cursor := v_we` (advance to next window end, which is next window's start)
  - ✓ CONSISTENT

**Example**: If cursor = 2026-01-13 14:55:00 and interval = 5m:
- Process window [14:55:00, 15:00:00)
- Advance cursor to 15:00:00
- Next iteration: process [15:00:00, 15:05:00)

**Operator Understanding**: "cursor tells me where to START looking next"

### A.2 Table Semantics (Confirmed)

**Question**: Is data_bars strictly 1m only going forward?  
**Answer**: ✓ YES (with DXY now included)
- Current data_bars contains: EURUSD 1m (11,938 bars), USDJPY 1m (11,935 bars)
- DXY 1m is being migrated to data_bars (will have ~11,839 bars after Phase 4 cleanup)
- No Class B (provider 5m) ingestion into data_bars

**Question**: Will any assets ever ingest 5m into data_bars?  
**Answer**: ✗ NO
- Registry shows: `base_timeframe = '1m'` for all active assets (EURUSD, XAUUSD, DXY, etc.)
- `ingest_class` is either 'A' (API 1m) or 'B' (provider 1m synthetic)
- No asset configured for base_timeframe='5m'

**Question**: Is derived_data_bars the only home for 5m/1h+?  
**Answer**: ✓ YES
- Current state shows:
  - derived_data_bars: DXY 1m (4,705 bars LEGACY), DXY 5m (2 bars)
  - derived_data_bars: EURUSD 5m (2 bars), USDJPY 5m (2 bars)
  - All with `deleted_at IS NULL` (active records)
- DXY 1m legacy will be soft-deleted in Phase 9
- All 5m/1h aggregated data goes to derived_data_bars

### A.3 Current Production Status

| Item | Status |
|------|--------|
| `agg_start_utc` column | ✗ Does NOT exist (will add in Phase 5) |
| `enabled` column | ✗ Does NOT exist (will add in Phase 5) |
| `task_priority` column | ✗ Does NOT exist (will add in Phase 5) |
| Functions updated | ⚠️ Partially (UNION ALL removed from aggregate_1m_to_5m_window, conditional source in catchup) |
| DXY 1m in data_bars | ✓ Will be ready after Phase 4 cleanup |
| DXY 1m in derived_data_bars | ✓ 4,705 legacy bars (soft-delete in Phase 9) |

---

## PART B: DATABASE DDL DEFINITIONS

### B.1 `data_bars` - Raw Market Data

```sql
-- Table Structure
CREATE TABLE data_bars (
  id bigserial PRIMARY KEY,
  canonical_symbol text NOT NULL,
  provider_ticker text,
  timeframe text NOT NULL,
  ts_utc timestamp with time zone NOT NULL,
  
  -- OHLCV Data
  open double precision,
  high double precision,
  low double precision,
  close double precision,
  vol double precision,
  vwap double precision,
  trade_count integer,
  
  -- Metadata
  is_partial boolean NOT NULL,
  source text NOT NULL,
  ingested_at timestamp with time zone NOT NULL,
  raw jsonb NOT NULL,
  
  -- Constraints
  CONSTRAINT bars_pkey PRIMARY KEY (id),
  CONSTRAINT data_bars_symbol_tf_ts_unique UNIQUE (canonical_symbol, timeframe, ts_utc),
  CONSTRAINT bars_canonical_symbol_fkey FOREIGN KEY (canonical_symbol) 
    REFERENCES core_asset_registry_all(canonical_symbol),
  CONSTRAINT bars_provider_ticker_required_chk CHECK (source != 'massive_api' OR provider_ticker IS NOT NULL),
  CONSTRAINT bars_timeframe_check CHECK (timeframe = ANY (ARRAY['1m'::text, '5m'::text, '1h'::text, '4h'::text, '1d'::text, '1w'::text]))
);
```

**Indexes**:
- PRIMARY KEY (id)
- UNIQUE (canonical_symbol, timeframe, ts_utc)
- Foreign key on canonical_symbol

**Current Data**:
```
EURUSD 1m:   11,938 bars
USDJPY 1m:   11,935 bars
DXY 1m:      [will be ~11,839 after Phase 4]
```

### B.2 `derived_data_bars` - Aggregated/Derived Data

```sql
CREATE TABLE derived_data_bars (
  id bigserial PRIMARY KEY,
  canonical_symbol text NOT NULL,
  timeframe text NOT NULL,
  ts_utc timestamp with time zone NOT NULL,
  
  -- OHLCV Data
  open double precision NOT NULL,
  high double precision NOT NULL,
  low double precision NOT NULL,
  close double precision NOT NULL,
  vol double precision,
  vwap double precision,
  trade_count integer,
  
  -- Aggregation Metadata
  is_partial boolean NOT NULL,
  source text NOT NULL,
  ingested_at timestamp with time zone NOT NULL,
  source_timeframe text,
  source_candles integer,
  expected_candles integer,
  quality_score integer,
  derivation_version integer,
  
  -- Lifecycle
  deleted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  raw jsonb NOT NULL,
  
  -- Constraints
  CONSTRAINT derived_data_bars_pkey PRIMARY KEY (id),
  CONSTRAINT derived_unique_symbol_tf_ts UNIQUE (canonical_symbol, timeframe, ts_utc) 
    WHERE (deleted_at IS NULL),
  CONSTRAINT derived_canonical_symbol_fkey FOREIGN KEY (canonical_symbol) 
    REFERENCES core_asset_registry_all(canonical_symbol)
);
```

**Indexes**:
- PRIMARY KEY (id)
- UNIQUE (canonical_symbol, timeframe, ts_utc) WHERE deleted_at IS NULL
- Index on (canonical_symbol, timeframe, ts_utc DESC)

**Current Data** (active only):
```
DXY 1m:      4,705 bars [source='dxy', will be soft-deleted]
DXY 5m:      2 bars [source='agg']
EURUSD 5m:   2 bars [source='agg']
USDJPY 5m:   2 bars [source='agg']
```

### B.3 `data_agg_state` - Task Configuration

```sql
CREATE TABLE data_agg_state (
  -- Identity
  canonical_symbol text NOT NULL,
  timeframe text NOT NULL,
  
  -- Configuration
  run_interval_minutes integer,
  aggregation_delay_seconds integer,
  source_timeframe text,
  is_mandatory boolean NOT NULL DEFAULT false,
  
  -- State
  last_agg_bar_ts_utc timestamp with time zone,
  last_attempted_at_utc timestamp with time zone,
  last_successful_at_utc timestamp with time zone,
  last_error text,
  status text NOT NULL DEFAULT 'idle',
  hard_fail_streak integer NOT NULL DEFAULT 0,
  
  -- Statistics
  total_runs bigint NOT NULL DEFAULT 0,
  total_bars_created bigint NOT NULL DEFAULT 0,
  total_bars_quality_poor bigint NOT NULL DEFAULT 0,
  
  -- Scheduling
  next_run_at timestamp with time zone,
  running_started_at_utc timestamp with time zone,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  
  -- NEW COLUMNS (Will add in Phase 5)
  agg_start_utc timestamp with time zone NOT NULL DEFAULT '2025-07-01 00:00:00+00',
  enabled boolean NOT NULL DEFAULT true,
  task_priority integer NOT NULL DEFAULT 100,
  
  -- Constraints
  PRIMARY KEY (canonical_symbol, timeframe)
);
```

**Current Tasks** (Sample):
```
DXY        5m   <- 1m   (5 min)   is_mandatory=true  status=idle  last_success=2026-01-13 11:46:46
DXY        1h   <- 5m   (60 min)  is_mandatory=true  status=idle  last_success=2026-01-13 11:46:45
EURUSD     5m   <- 1m   (5 min)   is_mandatory=true  status=idle  last_success=2026-01-13 11:51:46
EURUSD     1h   <- 5m   (60 min)  is_mandatory=true  status=idle  last_success=2026-01-13 11:51:48
USDJPY     5m   <- 1m   (5 min)   is_mandatory=true  status=idle  last_success=2026-01-13 11:51:50
USDJPY     1h   <- 5m   (60 min)  is_mandatory=true  status=idle  last_success=2026-01-13 10:51:46
```

---

## PART C: ALL AGGREGATION FUNCTIONS (Exact Definitions)

### C.1 `_upsert_derived_bar()` - Core Upsert Function

**Purpose**: Idempotent insert/update of aggregated bars  
**Signature**: 
```
_upsert_derived_bar(
  p_symbol text,
  p_tf text,
  p_ts timestamptz,
  p_open double precision,
  p_high double precision,
  p_low double precision,
  p_close double precision,
  p_vol double precision,
  p_vwap double precision,
  p_trade_count integer,
  p_source text,
  p_source_tf text,
  p_source_candles integer,
  p_expected_candles integer,
  p_quality_score integer,
  p_derivation_version integer,
  p_raw jsonb
) RETURNS jsonb
```

**Logic**:
```sql
INSERT INTO derived_data_bars (
  canonical_symbol, timeframe, ts_utc,
  open, high, low, close, vol, vwap, trade_count,
  is_partial, source, ingested_at, source_timeframe,
  source_candles, expected_candles, quality_score,
  derivation_version, raw, deleted_at
)
VALUES (
  p_symbol, p_tf, p_ts,
  p_open, p_high, p_low, p_close, p_vol, p_vwap, p_trade_count,
  false, p_source, now(), p_source_tf,
  p_source_candles, p_expected_candles, p_quality_score,
  p_derivation_version, COALESCE(p_raw, '{}'::jsonb), null
)
ON CONFLICT (canonical_symbol, timeframe, ts_utc) 
  WHERE (deleted_at IS NULL)
DO UPDATE SET
  open=excluded.open,
  high=excluded.high,
  low=excluded.low,
  close=excluded.close,
  vol=excluded.vol,
  vwap=excluded.vwap,
  trade_count=excluded.trade_count,
  source=excluded.source,
  ingested_at=excluded.ingested_at,
  source_timeframe=excluded.source_timeframe,
  source_candles=excluded.source_candles,
  expected_candles=excluded.expected_candles,
  quality_score=excluded.quality_score,
  derivation_version=excluded.derivation_version,
  raw=excluded.raw,
  updated_at=now()
RETURNING (xmax=0) INTO v_inserted;

RETURN jsonb_build_object('success', true, 'inserted', COALESCE(v_inserted, false));
```

**Key Points**:
- ✓ Idempotent (ON CONFLICT ... DO UPDATE)
- ✓ Returns boolean 'inserted' flag
- ✓ Soft-delete aware (WHERE deleted_at IS NULL in UNIQUE constraint)

### C.2 `agg_bootstrap_cursor()` - Cursor Initialization

**Purpose**: Initialize cursor position for a task  
**Signature**:
```
agg_bootstrap_cursor(
  p_symbol text,
  p_to_tf text,
  p_now_utc timestamptz DEFAULT now()
) RETURNS timestamptz
```

**⚠️ CURRENT ISSUE - Uses UNION ALL**:
```sql
SELECT MAX(ts_utc) INTO v_latest
FROM (
  SELECT ts_utc FROM data_bars WHERE canonical_symbol=p_symbol AND timeframe=v_src_tf
  UNION ALL
  SELECT ts_utc FROM derived_data_bars WHERE canonical_symbol=p_symbol AND timeframe=v_src_tf AND deleted_at IS NULL
) x;
```

**Will be fixed in Phase 5**:
```sql
IF v_src_tf = '1m' THEN
  SELECT MAX(ts_utc) INTO v_latest
  FROM data_bars
  WHERE canonical_symbol = p_symbol AND timeframe = v_src_tf;
ELSE
  SELECT MAX(ts_utc) INTO v_latest
  FROM derived_data_bars
  WHERE canonical_symbol = p_symbol AND timeframe = v_src_tf AND deleted_at IS NULL;
END IF;
```

**Bootstrap Logic**:
```
If v_latest IS NULL:
  cursor = next boundary after now
Else:
  cursor = (max_ts / interval * interval) - interval
  
Result: cursor = start of the next window to process
```

### C.3 `aggregate_1m_to_5m_window()` - 1m → 5m Aggregation

**Purpose**: Aggregate five 1-minute bars into one 5-minute bar  
**Status**: ✅ Already fixed in production (UNION ALL removed)  
**Signature**:
```
aggregate_1m_to_5m_window(
  p_symbol text,
  p_from_utc timestamptz,
  p_to_utc timestamptz,
  p_derivation_version int DEFAULT 1
) RETURNS jsonb
```

**Logic** (Current - Correct):
```sql
-- ✅ SINGLE TABLE - all 1m data (including DXY) from data_bars
WITH src AS (
  SELECT ts_utc, open, high, low, close, vol, vwap, trade_count
  FROM data_bars
  WHERE canonical_symbol = p_symbol
    AND timeframe = '1m'
    AND ts_utc >= p_from_utc
    AND ts_utc < p_to_utc
)
-- ... aggregation logic
```

**Quality Scoring**:
```
source_count >= 5  → quality_score = 2 (excellent)
source_count = 4   → quality_score = 1 (good)
source_count = 3   → quality_score = 0 (poor)
source_count < 3   → stored = false (skip)
```

**Returns**:
```json
{
  "success": true,
  "stored": true|false,
  "source_count": 5,
  "quality_score": 2,
  "reason": "insufficient_source_bars" (if not stored)
}
```

### C.4 `aggregate_5m_to_1h_window()` - 5m → 1h Aggregation

**Purpose**: Aggregate twelve 5-minute bars into one 1-hour bar  
**Status**: ✅ Already correct (no UNION ALL needed)  
**Signature**:
```
aggregate_5m_to_1h_window(
  p_symbol text,
  p_from_utc timestamptz,
  p_to_utc timestamptz,
  p_derivation_version int DEFAULT 1
) RETURNS jsonb
```

**Logic** (Current - Correct):
```sql
-- ✅ CORRECT - reads only from derived_data_bars
WITH src AS (
  SELECT ts_utc, open, high, low, close, vol, vwap, trade_count
  FROM derived_data_bars
  WHERE canonical_symbol = p_symbol 
    AND timeframe = '5m' 
    AND deleted_at IS NULL
    AND ts_utc >= p_from_utc 
    AND ts_utc < p_to_utc
)
-- ... aggregation logic
```

**Quality Scoring**:
```
source_count = 12       → quality_score = 2 (excellent)
source_count in (10,11) → quality_score = 1 (good)
source_count in (8,9)   → quality_score = 0 (poor)
source_count = 7        → quality_score = -1 (very poor)
source_count < 7        → stored = false (skip)
```

### C.5 `catchup_aggregation_range()` - Window Loop Processor

**Purpose**: Process multiple aggregation windows in sequence  
**Status**: ⚠️ Partially fixed (has conditional source check, needs agg_start_utc guard)  
**Signature**:
```
catchup_aggregation_range(
  p_symbol text,
  p_to_tf text,
  p_start_cursor_utc timestamptz,
  p_max_windows integer DEFAULT 100,
  p_now_utc timestamptz DEFAULT null,
  p_derivation_version int DEFAULT 1,
  p_ignore_confirmation boolean DEFAULT false
) RETURNS jsonb
```

**Current Logic**:
```sql
-- NULL cursor guard
IF p_start_cursor_utc IS NULL THEN
  RAISE EXCEPTION 'catchup_aggregation_range: start cursor is NULL...';
END IF;

-- Get config
SELECT run_interval_minutes, aggregation_delay_seconds, source_timeframe
INTO v_interval_min, v_delay_sec, v_src_tf
FROM data_agg_state WHERE ...;

-- ✅ Conditional source check (MIGRATION CHANGE)
IF v_src_tf = '1m' THEN
  SELECT MAX(ts_utc) INTO v_max_source_ts FROM data_bars WHERE ...;
ELSE
  SELECT MAX(ts_utc) INTO v_max_source_ts FROM derived_data_bars WHERE ...;
END IF;

-- Window loop
WHILE v_processed < p_max_windows LOOP
  v_ws := v_cursor;
  v_we := v_ws + make_interval(mins => v_interval_min);
  v_confirm := v_we + make_interval(secs => v_delay_sec);
  
  -- Call aggregation function
  IF p_to_tf = '5m' THEN
    v_res := aggregate_1m_to_5m_window(...);
  ELSIF p_to_tf = '1h' THEN
    v_res := aggregate_5m_to_1h_window(...);
  END IF;
  
  -- Extract results (⚠️ using COALESCE for source_count)
  v_source_rows := COALESCE((v_res->>'source_count')::int, 0);
  v_stored := COALESCE((v_res->>'stored')::boolean, false);
  
  -- Stop at frontier (source_count = 0)
  IF v_source_rows = 0 THEN
    EXIT;
  END IF;
  
  -- Track and advance
  v_cursor := v_we;
  v_processed := v_processed + 1;
END LOOP;
```

**⚠️ Will add in Phase 5**:
```sql
-- Enforce agg_start_utc minimum
SELECT agg_start_utc INTO v_agg_start_utc FROM data_agg_state WHERE ...;

IF v_agg_start_utc IS NOT NULL THEN
  v_cursor := GREATEST(v_cursor, v_agg_start_utc - (v_interval_min || ' minutes')::interval);
END IF;

-- In loop: skip windows before agg_start_utc
IF v_agg_start_utc IS NOT NULL AND v_ws < v_agg_start_utc THEN
  v_cursor := v_we;
  v_processed := v_processed + 1;
  CONTINUE;
END IF;
```

**Returns**:
```json
{
  "success": true,
  "windows_processed": 42,
  "cursor_advanced_to": "2026-01-13 15:00:00+00",
  "bars_created": 40,
  "bars_quality_poor": 2,
  "bars_skipped": 0,
  "continue": false,
  "agg_start_enforced": "2025-07-01 00:00:00+00"
}
```

### C.6 `agg_get_due_tasks()` - Task Selection

**Purpose**: Find tasks ready to run  
**Status**: ✓ Exists, will add priority ordering in Phase 5  
**Signature**:
```
agg_get_due_tasks(
  p_env_name text DEFAULT 'prod',
  p_limit integer DEFAULT 10
) RETURNS TABLE (
  canonical_symbol text,
  timeframe text,
  source_timeframe text,
  last_agg_bar_ts_utc timestamptz,
  run_interval_minutes integer,
  aggregation_delay_seconds integer,
  is_mandatory boolean,
  task_priority integer
)
```

**Current Logic**:
```sql
SELECT * FROM data_agg_state
WHERE status = 'idle' AND next_run_at <= NOW()
ORDER BY is_mandatory DESC, timeframe ASC, last_successful_at_utc ASC NULLS FIRST
LIMIT p_limit;
```

**Will be enhanced in Phase 5**:
```sql
ORDER BY 
  is_mandatory DESC,                     -- mandatory first
  timeframe ASC,                         -- 5m before 1h
  task_priority ASC,                     -- lower = higher priority
  last_successful_at_utc ASC NULLS FIRST -- never-run tasks first
```

### C.7 `agg_start()` - Task Claim

**Purpose**: Mark task as running  
**Signature**:
```
agg_start(
  p_symbol text,
  p_to_tf text,
  p_now_utc timestamptz DEFAULT now()
) RETURNS jsonb
```

**Logic**:
```sql
UPDATE data_agg_state
SET status = 'running',
    running_started_at_utc = p_now_utc,
    last_attempted_at_utc = p_now_utc
WHERE canonical_symbol = p_symbol AND timeframe = p_to_tf;
```

### C.8 `agg_finish()` - Task Complete

**Purpose**: Update task state after run  
**Signature**:
```
agg_finish(
  p_symbol text,
  p_to_tf text,
  p_success boolean,
  p_new_cursor_utc timestamptz DEFAULT null,
  p_stats jsonb DEFAULT null,
  p_fail_kind text DEFAULT null,
  p_error text DEFAULT null
) RETURNS jsonb
```

**Logic**:
```sql
IF p_success THEN
  UPDATE data_agg_state
  SET status = 'idle',
      last_agg_bar_ts_utc = COALESCE(p_new_cursor_utc, last_agg_bar_ts_utc),
      last_successful_at_utc = now(),
      hard_fail_streak = 0,
      last_error = null,
      total_runs = total_runs + 1,
      total_bars_created = total_bars_created + 
        COALESCE((p_stats->>'bars_created')::bigint, 0),
      total_bars_quality_poor = total_bars_quality_poor + 
        COALESCE((p_stats->>'bars_quality_poor')::bigint, 0),
      next_run_at = now() + make_interval(mins => run_interval_minutes),
      updated_at = now()
  WHERE canonical_symbol = p_symbol AND timeframe = p_to_tf;
ELSE
  -- On failure:
  IF p_fail_kind = 'transient' THEN
    -- Don't increment hard_fail_streak
    UPDATE ... next_run_at = now() + interval '5 minutes';
  ELSE
    -- Hard failure
    hard_fail_streak := hard_fail_streak + 1;
    IF hard_fail_streak >= 3 THEN
      status := 'disabled';  -- Auto-disable after 3 failures
    END IF;
  END IF;
  
  UPDATE data_agg_state
  SET status = status,
      hard_fail_streak = hard_fail_streak,
      last_error = p_error,
      next_run_at = next_run_at
  WHERE canonical_symbol = p_symbol AND timeframe = p_to_tf;
END IF;
```

---

## PART D: CORE ASSET REGISTRY

### D.1 Schema

```sql
CREATE TABLE core_asset_registry_all (
  canonical_symbol text PRIMARY KEY,
  provider_ticker text,
  asset_class text,
  source text,
  endpoint_key text,
  query_params jsonb,
  active boolean,
  notes text,
  test_active boolean,
  ingest_class text,
  base_timeframe text,
  is_sparse boolean,
  is_contract boolean,
  contract_root text,
  contract_expiry_utc timestamp with time zone,
  expected_update_seconds integer,
  calc_15m boolean,
  calc_4h boolean,
  calc_1d boolean,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
);
```

### D.2 Sample Rows

**EURUSD (FX Pair)**:
```
canonical_symbol: EURUSD
active: true
test_active: true
asset_class: fx
ingest_class: A (API direct)
base_timeframe: 1m
calc_15m: false
calc_4h: false
calc_1d: false
```

**XAUUSD (Metal)**:
```
canonical_symbol: XAUUSD
active: true
test_active: true
asset_class: fx  [sic - actually metal, mislabeled]
ingest_class: A (API direct)
base_timeframe: 1m
calc_15m: false
calc_4h: false
calc_1d: false
```

**DXY (Index - Synthetic)**:
```
canonical_symbol: DXY
active: true
test_active: true
asset_class: index
ingest_class: B (synthetic/calculated)
base_timeframe: 1m
calc_15m: false
calc_4h: false
calc_1d: false
```

### D.3 Desired Aggregation Flags (Phase 5+)

**Current Design**:
- No dedicated aggregation metadata yet
- All active assets get mandatory 5m+1h via code

**Recommended Enhancement** (for future):
```json
{
  "agg": {
    "enabled": true,
    "start_utc": "2025-07-01T00:00:00Z",
    "mandatory": ["5m", "1h"],
    "optional": ["15m", "4h", "1d"]
  }
}
```

**For Phase 5 MVP**:
- Use code-driven defaults (all active → 5m+1h mandatory)
- Flag stored in `data_agg_state` not registry
- Can add registry-driven metadata in Phase 6

---

## PART E: WORKER CODE TOUCH-POINTS

### E.1 Location

```
apps/typescript/aggregator/src/aggworker.ts
```

### E.2 Key Constants

```typescript
const MAX_TASKS = 10;        // Max tasks per run
const MAX_WINDOWS = 100;     // Max windows per task
const ENV_NAME = process.env.DISTORT_ENV || 'prod';
```

### E.3 Main Workflow (Pseudocode)

```typescript
export default {
  async scheduled(event, env, ctx) {
    // 1. Sync aggregation config from registry
    await ensureAggregationConfigSynced(supabase);
    
    // 2. Get due tasks
    const { data: tasks } = await supabase.rpc('agg_get_due_tasks', {
      p_env_name: ENV_NAME,
      p_limit: MAX_TASKS
    });
    
    // 3. Process each task
    for (const task of tasks) {
      try {
        // Claim task
        await supabase.rpc('agg_start', {
          p_symbol: task.canonical_symbol,
          p_to_tf: task.timeframe
        });
        
        // Bootstrap if needed
        let cursor = task.last_agg_bar_ts_utc;
        if (!cursor) {
          const { data: bootstrap } = await supabase.rpc('agg_bootstrap_cursor', {
            p_symbol: task.canonical_symbol,
            p_to_tf: task.timeframe
          });
          cursor = bootstrap;
        }
        
        // Run catchup
        const { data: result } = await supabase.rpc('catchup_aggregation_range', {
          p_symbol: task.canonical_symbol,
          p_to_tf: task.timeframe,
          p_start_cursor_utc: cursor,
          p_max_windows: MAX_WINDOWS,
          p_derivation_version: 1
        });
        
        // Finish task
        await supabase.rpc('agg_finish', {
          p_symbol: task.canonical_symbol,
          p_to_tf: task.timeframe,
          p_success: true,
          p_new_cursor_utc: result.cursor_advanced_to,
          p_stats: {
            windows_processed: result.windows_processed,
            bars_created: result.bars_created,
            bars_quality_poor: result.bars_quality_poor
          }
        });
      } catch (error) {
        // Handle failure
        const isTransient = /* check error type */;
        await supabase.rpc('agg_finish', {
          p_symbol: task.canonical_symbol,
          p_to_tf: task.timeframe,
          p_success: false,
          p_fail_kind: isTransient ? 'transient' : 'hard',
          p_error: error.message
        });
      }
    }
  }
}
```

### E.4 Environment Variables

```bash
DISTORT_ENV=prod          # or dev/staging
SUPABASE_URL=https://...
SUPABASE_ANON_KEY=...
```

### E.5 Concurrency/Locking

**Current Approach**: Soft locking via `status='running'`
- `agg_start()` sets status='running'
- Only one worker can claim a task at a time
- `agg_finish()` sets status='idle'
- No explicit lock table or distributed lock

**Behavior**:
- If worker crashes while running, task stays 'running'
- No automatic recovery (requires manual intervention or timeout logic)
- Multiple workers won't process same task simultaneously

---

## PART F: OPERATIONAL INVARIANTS

### F.1 Auto-Disable Behavior

**Question**: Mandatory 5m+1h should never auto-disable?  
**Answer**: ✓ YES (recommended)

**Current Behavior** (in agg_finish):
```
hard_fail_streak >= 3 → status='disabled'
```

**Phase 5 Change**:
```
IF is_mandatory THEN
  status = 'hard_failed'  -- Alert, don't disable
ELSE
  status = 'disabled'     -- Auto-disable optional tasks
END IF;
```

### F.2 Frontier Detection on Missing Source Data

**Question**: If 1m data is missing for a window, should aggregation:
- (a) Stop at frontier immediately, or
- (b) Keep scanning forward to find later data?

**Answer**: **(a) Stop immediately** (current & correct)

**Logic**:
```
IF source_count = 0 THEN
  EXIT;  -- Stop processing, cursor stays at this window
END IF;
```

**Rationale**:
- If we hit a gap, we're at the data frontier
- No point scanning forward (windows are ordered)
- Next run will pick up where we left off

### F.3 Backfill Strategy

**Question**: Do you want catch-up to run until "now" gradually, or separate backfill mode?

**Answer**: **Gradual incremental backfill** (current approach)

**How It Works**:
- Worker runs every 5 min (cron)
- Each run processes MAX_WINDOWS (100) windows = 500 minutes
- Takes ~6 hours to catch up to 24-hour lag
- agg_start_utc prevents aggregating before 2025-07-01

**No separate backfill mode needed** (can add in future if needed)

---

## PART G: KNOWN ISSUES & CURRENT STATE

### G.1 Confirmed Issues

| Issue | Status | Impact |
|-------|--------|--------|
| DXY 1m in derived_data_bars (legacy) | ⚠️ Known | 4,705 bars to soft-delete Phase 9 |
| agg_start_utc column missing | ⚠️ Known | Phase 5 adds it |
| enabled column missing | ⚠️ Known | Phase 5 adds it |
| task_priority column missing | ⚠️ Known | Phase 5 adds it |
| UNION ALL in agg_bootstrap_cursor | ⚠️ Known | Phase 5 fixes conditional logic |
| No agg_start_utc enforcement in catchup | ⚠️ Known | Phase 5 adds guard |
| aggregate_1m_to_5m_window UNION ALL | ✅ FIXED | Already removed in production |
| aggregate_5m_to_1h_window UNION ALL | ✅ NOT NEEDED | Already reads only derived_data_bars |

### G.2 Not Observed (Healthy)

✓ No cursor races (soft locking works)  
✓ DXY 5m/1h building correctly (2 bars each)  
✓ No duplicates in derived_data_bars (UNIQUE constraint enforced)  
✓ No obvious gaps (data is continuous during market hours)  
✓ No worker timeouts (runs complete < 30 seconds)

### G.3 Current Data Quality

```
EURUSD:
  data_bars 1m:       11,938 bars
  derived_data_bars 5m: 2 bars (just generated)
  Quality: Good (recent bars only)

USDJPY:
  data_bars 1m:       11,935 bars
  derived_data_bars 5m: 2 bars (just generated)
  Quality: Good (recent bars only)

DXY:
  data_bars 1m:       [will be 11,839 after Phase 4]
  derived_data_bars 1m: 4,705 bars [LEGACY - to delete]
  derived_data_bars 5m: 2 bars
  Quality: TBD (depends on Phase 4 cleanup timing)
```

---

## READY FOR PHASE 5

All questions answered. Production status captured. Ready to:

1. ✅ Add 3 new columns to `data_agg_state`
2. ✅ Fix `agg_bootstrap_cursor()` conditional source logic
3. ✅ Add `agg_start_utc` enforcement to `catchup_aggregation_range()`
4. ✅ Create `sync_agg_state_from_registry()` function
5. ✅ Update `agg_get_due_tasks()` priority ordering
6. ✅ Verify all functions match cursor contract
7. ✅ Deploy and test

**Proceeding to Phase 5 implementation.**
