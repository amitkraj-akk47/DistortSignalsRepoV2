# DXY Migration - Quick Reference Card

**Print this. Use during execution.**

---

## Pre-Execution Checklist

```bash
# 1. Backup
pg_dump -h $DB_HOST -U $DB_USER -d $DB_NAME \
  -t data_bars -t derived_data_bars \
  -t core_asset_registry_all \
  --file=backup_pre_dxy_$(date +%Y%m%d_%H%M%S).sql

# 2. Verify connectivity
psql $DATABASE_URL -c "SELECT 1;"

# 3. Capture pre-state
psql $DATABASE_URL -c "
SELECT 'DXY 1m data_bars' as loc, COUNT(*) FROM data_bars 
WHERE canonical_symbol='DXY' AND timeframe='1m'
UNION ALL
SELECT 'DXY 1m derived', COUNT(*) FROM derived_data_bars
WHERE canonical_symbol='DXY' AND timeframe='1m' AND deleted_at IS NULL;
"
```

---

## Phase Durations

| Phase | Time | Owner | Status |
|-------|------|-------|--------|
| 1: Pre-flight | 15m | DBA | ⬜️ |
| 2: Schema | 10m | DBA | ⬜️ |
| 3: Function | 15m | DBA | ⬜️ |
| 4: Data | 20m | DBA | ⬜️ |
| 5: Code | 30m | Engineer | ⬜️ |
| 6: Tests | 20m | Engineer | ⬜️ |
| 7: Deploy | 30m | DevOps | ⬜️ |
| 8: Monitor | 24h | On-call | ⬜️ |
| 9: Cleanup | 10m | DBA | ⬜️ |

---

## Critical Queries

### Schema Pre-Check
```sql
SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE tablename='data_bars' 
  AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%(canonical_symbol%') 
AS has_unique_idx;
-- Should be: true (if false, Phase 2 will fix it)
```

### Function Test
```sql
SELECT calc_dxy_range_1m(
  NOW() - INTERVAL '1 hour',
  NOW(),
  1
);
-- Should show: {"success":true, "inserted":...}
```

### Migration Verify
```sql
SELECT 
  COUNT(*) as dxy_1m_in_data_bars,
  COUNT(*) FILTER (WHERE source='synthetic') as synthetic_source
FROM data_bars
WHERE canonical_symbol='DXY' AND timeframe='1m';
-- Should match derived_data_bars count from pre-state
```

### 24h Health Check (Run Hourly During Phase 8)
```sql
SELECT 
  'DXY 1m' as asset,
  NOW() - MAX(ts_utc) as age,
  COUNT(*) as bars_last_hr,
  CASE WHEN NOW() - MAX(ts_utc) < INTERVAL '5 min' THEN 'OK' ELSE 'WARN' END as status
FROM data_bars
WHERE canonical_symbol='DXY' AND timeframe='1m' AND ts_utc > NOW() - INTERVAL '1 hour';
```

---

## Code Changes Summary

### Tick Factory
```python
# OLD: supabase.rpc('calc_dxy_range_derived', {...})
# NEW: supabase.rpc('calc_dxy_range_1m', {...})
```

### Aggregator (1m Source Query)
```python
# BEFORE: 2-table UNION ALL for 1m data
# AFTER: Single data_bars query
# Remove: "UNION ALL SELECT ... FROM derived_data_bars WHERE timeframe='1m'"
```

### Asset Registry
```sql
INSERT INTO core_asset_registry_all (canonical_symbol, ...)
VALUES ('DXY', ..., jsonb_build_object(
  'is_synthetic', true,
  'base_timeframe', '1m',
  'components', [...]
))
```

---

## Key Files to Have Open

1. Backup file: `backup_pre_dxy_YYYYMMDD_HHMMSS.sql`
2. Migration plan: [DXY_MIGRATION_PLAN_FINAL.md](DXY_MIGRATION_PLAN_FINAL.md)
3. Feedback doc: [DXY_MIGRATION_FEEDBACK_INCORPORATION.md](DXY_MIGRATION_FEEDBACK_INCORPORATION.md)

---

## Emergency Rollback (If Needed in First 24h)

```bash
# 1. Revert code (git revert / manual edit)
#    - Tick Factory: back to calc_dxy_range_derived
#    - Aggregator: restore UNION ALL

# 2. Keep data safe (Option B design)
#    - Old data still in derived_data_bars
#    - New data in data_bars (harmless, ignored)

# 3. No data needs to be deleted
# 4. Restart workers
pm2 restart tick-factory aggregator
```

---

## Success Indicators (Check Every Hour During Phase 8)

✅ DXY 1m bars appearing in `data_bars` every 1-5 min  
✅ Latest timestamp < 5 min old  
✅ Price range: 80-120 (typical)  
✅ DXY 5m bars still building  
✅ No errors in `pm2 logs`  

---

## Communication Plan

- **Hour 0-1**: Phases 1-4 (DBA, silent)
- **Hour 1-2**: Phases 5-6 (Engineer)
- **Hour 2-3**: Phase 7 (DevOps)
- **Hour 3-27**: Phase 8 (Monitoring, alerting if issues)
- **Hour 27-28**: Phase 9 (Cleanup)

---

## Gotchas to Avoid

❌ **Don't delete from derived_data_bars until 24h passes**  
(Option B design: keep for safety)

❌ **Don't assume aggregator auto-updates**  
(Phase 5 code changes required)

❌ **Don't skip schema checks in Phase 2**  
(Unique index is mandatory)

❌ **Don't run full test suite**  
(Just 3 health checks, 20 min max)

---

## Post-Deploy (Phase 8) Monitoring Template

```
Hour 1: ✅ Deployed, DXY fresh
Hour 2: ✅ Aggregation continues
Hour 6: ✅ No errors, price range OK
Hour 12: ✅ 12-hour stability check passed
Hour 24: ✅ All checks pass, ready for cleanup
```

---

## Cleanup Approval (After 24h)

Only after ALL of the following:
- ✅ 24 continuous hours of successful derivation
- ✅ DXY 5m/1h aggregation producing on schedule
- ✅ Zero errors in logs
- ✅ Price freshness maintained

Then execute Phase 9:
```sql
UPDATE derived_data_bars
SET deleted_at = NOW()
WHERE canonical_symbol='DXY' AND timeframe='1m' AND deleted_at IS NULL;
```

---

## Contacts

- **Database Issues**: DBA
- **Code Deployment**: Engineer
- **Infrastructure**: DevOps
- **On-Call**: [Your on-call rotation]

---

**Status**: Ready for execution  
**Last Updated**: 2025-01-13  
**Approved By**: [Pending]
