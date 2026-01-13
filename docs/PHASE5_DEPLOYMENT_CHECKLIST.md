# Phase 5 Deployment Checklist

**Status**: ✅ Ready to Deploy  
**Date**: 2026-01-13  
**Migration Files**: 
- Main: `db/migrations/011_aggregation_redesign.sql`
- Rollback: `db/migrations/011_aggregation_redesign_ROLLBACK.sql`

---

## Pre-Deployment (Manual)

- [ ] **DBA Review**: Review migration SQL (no dangerous operations, only adds/modifies)
- [ ] **Backup**: Backup production `data_agg_state` table
  ```bash
  pg_dump -h $SUPABASE_HOST -U postgres -d postgres -t data_agg_state > backup_agg_state_$(date +%Y%m%d_%H%M%S).sql
  ```

- [ ] **Quiet Period**: Schedule during low-market activity (no active aggregation runs)
- [ ] **Maintenance Window**: Block 30 minutes for execution + verification
- [ ] **Communication**: Notify team of deployment

---

## Deployment Steps

### Step 1: Connect to Database
**Choose ONE**:

**Option A: Supabase UI (SQL Editor)**
```
1. Log into Supabase dashboard
2. Navigate to SQL Editor
3. Create new query
4. Copy entire contents of 011_aggregation_redesign.sql
5. Paste into editor
6. Click "Run"
```

**Option B: psql CLI**
```bash
psql -h <supabase-host> \
     -U postgres \
     -d postgres \
     < db/migrations/011_aggregation_redesign.sql
```

**Option C: Docker (if available)**
```bash
docker exec -it postgres_container psql -U postgres -d postgres < 011_aggregation_redesign.sql
```

### Step 2: Verify Migration Completed
```sql
-- Should see all 3 new columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'data_agg_state'
  AND column_name IN ('agg_start_utc', 'enabled', 'task_priority')
ORDER BY ordinal_position;

-- Expected Output:
-- agg_start_utc  | timestamp with time zone | NO
-- enabled        | boolean                  | NO
-- task_priority  | integer                  | NO
```

### Step 3: Verify Functions Exist
```sql
-- Should return 5 rows (all Phase 5 functions)
SELECT proname, pronargs, prosecdef
FROM pg_proc
WHERE proname IN (
  'agg_bootstrap_cursor',
  'catchup_aggregation_range',
  'agg_finish',
  'agg_get_due_tasks',
  'sync_agg_state_from_registry'
)
ORDER BY proname;

-- Expected: 5 functions, all with prosecdef=true
```

### Step 4: Verify Index Created
```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'data_agg_state'
  AND indexname = 'idx_agg_state_due_priority';

-- Expected: 1 row with index definition
```

### Step 5: Verify Data Integrity
```sql
-- All tasks should have agg_start_utc set
SELECT COUNT(*) as null_count FROM data_agg_state 
WHERE agg_start_utc IS NULL;
-- Expected: 0

-- All tasks should be enabled by default
SELECT COUNT(*) as disabled_count FROM data_agg_state 
WHERE enabled = false;
-- Expected: 0

-- All tasks should have default priority
SELECT COUNT(DISTINCT task_priority) as priority_variance FROM data_agg_state;
-- Expected: 1 (all tasks have priority=100)

-- No hard_failed tasks initially
SELECT COUNT(*) as hard_failed_count FROM data_agg_state 
WHERE status = 'hard_failed';
-- Expected: 0
```

### Step 6: Quick Function Test
```sql
-- Test agg_bootstrap_cursor
SELECT agg_bootstrap_cursor('EURUSD', '5m'::text);
-- Expected: timestamp = 2025-07-01 00:00:00+00 or later boundary

-- Test agg_get_due_tasks
SELECT COUNT(*) as due_tasks FROM agg_get_due_tasks('prod', NOW(), 10, 10);
-- Expected: depends on current state (0 if all running, up to 10 if idle)

-- Test sync_agg_state_from_registry
SELECT * FROM sync_agg_state_from_registry('prod', '2025-07-01 00:00:00+00'::timestamptz);
-- Expected: result set with success=true and task counts
```

---

## Post-Deployment Monitoring (24 Hours)

### Every 5 Minutes
```sql
-- Check aggregation is running normally
SELECT s.canonical_symbol, s.timeframe, s.status,
       ROUND((EXTRACT(EPOCH FROM (NOW() - s.last_successful_at_utc)) / 60)::numeric, 2) as min_since_success
FROM data_agg_state s
WHERE s.is_mandatory = true
ORDER BY s.canonical_symbol, s.timeframe;

-- Expected: All status='idle' or 'running', min_since_success < 5
```

### Every Hour
```sql
-- Check lag is acceptable
SELECT s.canonical_symbol, s.timeframe,
       MAX(db.ts_utc) as latest_1m,
       s.last_agg_bar_ts_utc as cursor,
       ROUND(((EXTRACT(EPOCH FROM (MAX(db.ts_utc) - s.last_agg_bar_ts_utc)) / 60))::numeric, 2) as lag_minutes
FROM data_agg_state s
LEFT JOIN data_bars db ON db.canonical_symbol = s.canonical_symbol AND db.timeframe = '1m'
WHERE s.is_mandatory = true
GROUP BY s.canonical_symbol, s.timeframe, s.last_agg_bar_ts_utc
ORDER BY lag_minutes DESC;

-- Expected: lag_minutes < 60 for all mandatory tasks
```

### Every 12 Hours
```sql
-- Check for any hard_failed tasks
SELECT * FROM data_agg_state 
WHERE status = 'hard_failed';

-- Expected: 0 rows (no mandatory tasks should fail initially)

-- Check failure streak
SELECT canonical_symbol, timeframe, hard_fail_streak, last_error
FROM data_agg_state
WHERE hard_fail_streak > 0
ORDER BY hard_fail_streak DESC;

-- Expected: 0 rows (no failures expected)
```

### Once Per Day
```sql
-- Data quality check
SELECT ddb.canonical_symbol, ddb.timeframe,
       COUNT(*) as total_bars,
       COUNT(*) FILTER (WHERE quality_score >= 1) as good_bars,
       ROUND(100.0 * COUNT(*) FILTER (WHERE quality_score >= 1) / COUNT(*), 1) as quality_pct
FROM derived_data_bars ddb
WHERE ddb.deleted_at IS NULL
  AND ddb.ts_utc >= NOW() - INTERVAL '24 hours'
GROUP BY ddb.canonical_symbol, ddb.timeframe
ORDER BY quality_pct ASC;

-- Expected: quality_pct >= 90% for all timeframes
```

---

## Alert Conditions (Immediate Action)

**🚨 ALERT 1: Aggregation Lag > 1 Hour**
```sql
SELECT s.canonical_symbol, s.timeframe, 
       ROUND(((EXTRACT(EPOCH FROM (NOW() - s.last_successful_at_utc)) / 60))::numeric, 1) as min_idle
FROM data_agg_state s
WHERE s.is_mandatory = true 
  AND NOW() - s.last_successful_at_utc > INTERVAL '1 hour';
```
**Action**: Check worker logs, verify database connectivity, restart worker if needed.

**🚨 ALERT 2: Hard Failed Task**
```sql
SELECT * FROM data_agg_state WHERE status = 'hard_failed';
```
**Action**: Investigate root cause, fix manually, set status='idle' to re-enable.

**🚨 ALERT 3: Hard Fail Streak > 0**
```sql
SELECT canonical_symbol, timeframe, hard_fail_streak, last_error
FROM data_agg_state WHERE hard_fail_streak > 0;
```
**Action**: Same as ALERT 2 - investigate and reset manually.

---

## If Rollback Needed

**⏱️ Estimated Time**: ~5 minutes

```bash
# Option A: Supabase UI
# 1. SQL Editor → Create new query
# 2. Copy entire contents of 011_aggregation_redesign_ROLLBACK.sql
# 3. Click "Run"

# Option B: psql
psql -h <supabase-host> \
     -U postgres \
     -d postgres \
     < db/migrations/011_aggregation_redesign_ROLLBACK.sql
```

**Verify Rollback**:
```sql
-- Columns should be removed
SELECT COUNT(*) FROM information_schema.columns
WHERE table_name = 'data_agg_state'
  AND column_name IN ('agg_start_utc', 'enabled', 'task_priority');
-- Expected: 0

-- Functions should be removed
SELECT COUNT(*) FROM pg_proc
WHERE proname IN ('agg_bootstrap_cursor', 'catchup_aggregation_range', 'agg_finish', 'agg_get_due_tasks', 'sync_agg_state_from_registry');
-- Expected: 0

-- Index should be removed
SELECT COUNT(*) FROM pg_indexes
WHERE tablename = 'data_agg_state' AND indexname = 'idx_agg_state_due_priority';
-- Expected: 0
```

---

## Success Criteria

✅ **Phase 5 Deployment Successful When All Met**:

1. ✅ Migration executes without errors (no NOTICE/ERROR in output)
2. ✅ All 3 new columns exist with correct types
3. ✅ All 5 functions exist with correct signatures
4. ✅ Index created on data_agg_state
5. ✅ All tasks have agg_start_utc = 2025-07-01
6. ✅ All tasks enabled by default (enabled=true)
7. ✅ All tasks have task_priority=100
8. ✅ Aggregation completes within 5 minutes
9. ✅ Aggregation lag < 1 hour for all mandatory tasks
10. ✅ Zero hard_failed tasks (no mandatory failures)
11. ✅ Zero hard_fail_streak (no failures)
12. ✅ Data quality stable (>90% good bars)

---

## Deployment Timeline

| Phase | Task | Duration | Owner |
|-------|------|----------|-------|
| Pre | Review + Backup | 10 min | DBA |
| Deploy | Execute migration | 2 min | DBA |
| Verify | Run checks 1-6 | 5 min | DBA |
| Monitor | 24-hour observation | 24 hr | Ops |
| **Total** | | **~24.5 hours** | |

---

## References

- **Migration**: [011_aggregation_redesign.sql](../db/migrations/011_aggregation_redesign.sql)
- **Rollback**: [011_aggregation_redesign_ROLLBACK.sql](../db/migrations/011_aggregation_redesign_ROLLBACK.sql)
- **Design Guide**: [PHASE5_DEPLOYMENT_GUIDE.md](./PHASE5_DEPLOYMENT_GUIDE.md)
- **Requirements**: [PHASE5_REQUIREMENTS_ARTIFACT.md](./PHASE5_REQUIREMENTS_ARTIFACT.md)

---

**Next Step**: Execute migration → Monitor → Proceed to Phase 6

**Questions?** Refer to design documents or contact database team.
