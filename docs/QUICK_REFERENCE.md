# Quick Reference: Orphaned State Records Fix

**Status**: ✅ Ready to Deploy  
**Date**: 2026-01-13

---

## TL;DR

**Problem**: `exceededCpu` timeouts caused by 3 orphaned state records  
**Fix**: Database cleanup + runtime safeguard  
**Time to Deploy**: ~10 minutes  

---

## Files Created/Modified

### Code Changes
```
✅ apps/typescript/tick-factory/src/ingestindex.ts
   └─ Added STEP 0.5: Safeguard check (lines 1143-1195)
```

### Migrations
```
✅ db/migrations/007_cleanup_orphaned_ingest_state.sql
   └─ Deletes 3 orphaned records
   
✅ db/migrations/008_add_notes_column_to_ingest_state.sql
   └─ Adds tracking column for orphaned records
```

### Documentation
```
✅ docs/ORPHANED_STATE_SAFEGUARD.md
✅ docs/ORPHANED_INGEST_STATE_FIX.md
✅ docs/INGEST_WORKER_CODE_REVIEW.md
✅ docs/SAFEGUARD_IMPLEMENTATION_SUMMARY.md
✅ docs/COMPLETE_SOLUTION.md
✅ docs/QUICK_REFERENCE.md (this file)
```

### Verification Scripts
```
✅ scripts/verify-orphaned-state.py
✅ scripts/verify-safeguard.py
```

---

## What the Safeguard Does

```
For each asset in the ingestion loop:

STEP 0.5: SAFEGUARD CHECK
├─ Does state record exist?
├─ Is asset still active?
├─ If state exists but asset disabled:
│  ├─ Mark as status='orphaned'
│  ├─ Add note: "ORPHAN RECORD: Asset disabled on [DATE]..."
│  ├─ Log warning
│  └─ Skip to next asset
└─ Continue with normal processing
```

---

## Deployment Steps

### 1. Apply Database Migrations
```bash
# Connect to database and run:
cat db/migrations/007_cleanup_orphaned_ingest_state.sql | psql $PG_DSN
cat db/migrations/008_add_notes_column_to_ingest_state.sql | psql $PG_DSN
```

### 2. Deploy Updated Worker Code
```bash
cd apps/typescript/tick-factory
npm run deploy  # or your deploy command
```

### 3. Verify
```bash
python3 scripts/verify-safeguard.py
# Should show all ✅ checks passing
```

---

## Expected Results After Deployment

| Before | After |
|--------|-------|
| ❌ exceededCpu errors | ✅ No timeouts |
| ❌ 3 orphaned records | ✅ Records cleaned + marked |
| ❌ Job fails | ✅ Job succeeds |
| ❌ 2.7s then crash | ✅ ~1.8s success |

---

## Monitoring

### Look for These Log Messages
```
✅ ORPHANED_STATE: Orphaned state record detected for XAGUSD (1m), marking and skipping
✅ JOB_RUN_COMPLETED: Job completed successfully
✅ No exceededCpu errors
```

### Run Verification Queries
```sql
-- Check marked orphaned records
SELECT COUNT(*) FROM data_ingest_state WHERE status='orphaned';

-- Check job run success
SELECT * FROM ops_job_runs ORDER BY created_at DESC LIMIT 5;
```

---

## Key Features of Safeguard

| Feature | Benefit |
|---------|---------|
| **Detects orphaned records** | Prevents CPU timeouts |
| **Marks with status & note** | Operational visibility |
| **Skips processing** | Other assets continue |
| **Non-blocking** | Doesn't stop the run |
| **Detailed logging** | Easy to monitor |
| **Graceful errors** | Won't break on edge cases |

---

## What Gets Marked

When safeguard finds an orphaned record:

```sql
UPDATE data_ingest_state SET
  status = 'orphaned',
  notes = 'ORPHAN RECORD: Asset disabled on 2026-01-13T00:15:30.456Z but state record was not cleaned up. This record should be deleted.'
WHERE canonical_symbol = 'XAGUSD' AND timeframe = '1m';
```

Result visible in database:
```
SELECT * FROM data_ingest_state WHERE status='orphaned';

canonical_symbol | timeframe | status   | notes
-----------------+-----------+----------+────────────────────────────
XAGUSD           | 1m        | orphaned | ORPHAN RECORD: Asset disabled on...
```

---

## Safeguard Logic (Simplified)

```typescript
// Check if state record exists but asset is disabled
const stateExists = await checkStateRecord(symbol, timeframe);
const assetActive = await checkAssetActive(symbol);

if (stateExists && !assetActive) {
  // Mark as orphaned
  markAsOrphaned(symbol, timeframe);
  // Skip processing
  continue;
}
```

---

## Subrequests Impact

**Safeguard adds 2 subrequests per asset**:
1. Check if state record exists (+1)
2. Check if asset is active (+1)

**Total overhead**: +2 per asset, ~20 per run (max)  
**Still within limits**: 50+ subrequests allowed

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Column `notes` doesn't exist | Run migration 008 |
| Code changes not deployed | Redeploy worker |
| Still seeing exceededCpu | Check migration 007 ran |
| Safeguard not triggering | Verify safeguard code in STEP 0.5 |

---

## Testing Safeguard (Optional)

To manually test if safeguard works:

```sql
-- Disable an active asset
UPDATE core_asset_registry_all SET active=false 
WHERE canonical_symbol='TESTASSET';

-- Keep its state record
INSERT INTO data_ingest_state (canonical_symbol, timeframe, status)
VALUES ('TESTASSET', '1m', 'running');

-- Run worker - it should skip TESTASSET and mark it orphaned
```

---

## Rollback (if needed)

**If you need to rollback**:
```bash
# 1. Redeploy old worker code (removes safeguard)
cd apps/typescript/tick-factory
git checkout HEAD~1  # or previous version
npm run deploy

# 2. Optionally revert migrations (but leave cleanup in place)
# Don't restore deleted orphaned records - they were problematic
```

---

## Success Criteria

Deployment is successful when:
- [ ] Job runs complete without `exceededCpu`
- [ ] All active assets (9) are processed
- [ ] orphaned records marked in database
- [ ] Logs show `skip_reasons: { orphaned_state_record: 1 }`
- [ ] Worker duration < 3 seconds
- [ ] No worker restarts

---

## References

- 🔗 [Full Safeguard Guide](./ORPHANED_STATE_SAFEGUARD.md)
- 🔗 [Issue Diagnosis](./INGEST_WORKER_CODE_REVIEW.md)
- 🔗 [Complete Solution](./COMPLETE_SOLUTION.md)
- 🔗 [Database Cleanup](./ORPHANED_INGEST_STATE_FIX.md)

---

**Questions?** See the detailed docs listed above.

**Ready to deploy?** Follow "Deployment Steps" section.
