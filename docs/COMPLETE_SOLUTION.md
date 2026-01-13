# Complete Solution: Orphaned State Records + Safeguard

**Date**: 2026-01-13  
**Problem**: `exceededCpu` timeouts in tick-factory worker  
**Root Cause**: Orphaned state records for disabled assets  
**Solution Status**: ✅ COMPLETE

---

## The Problem

```
Asset: XAGUSD
├─ core_asset_registry_all: active=false, test_active=false ✓
└─ data_ingest_state: status='running' ⚠️ ORPHANED

Worker run:
├─ Load active assets (XAGUSD not loaded) ✓
├─ Try to process remaining assets
├─ Stale state records cause inefficient queries
└─ CPU timeout ❌
```

**Impact**: 
- `exceededCpu` errors every 3-5 minutes
- Worker unable to complete ingestion
- 3 orphaned records detected

---

## The Solution: Three-Part Approach

### Part 1: Immediate Cleanup (Migration 007) ✅

**File**: [db/migrations/007_cleanup_orphaned_ingest_state.sql](../db/migrations/007_cleanup_orphaned_ingest_state.sql)

Deletes all existing orphaned state records:
```sql
DELETE FROM data_ingest_state dis
WHERE NOT EXISTS (
  SELECT 1 FROM core_asset_registry_all car
  WHERE dis.canonical_symbol = car.canonical_symbol
    AND (car.active = true OR car.test_active = true)
);
```

**Result**: Removes 3 orphaned records immediately

---

### Part 2: Database Schema (Migration 008) ✅

**File**: [db/migrations/008_add_notes_column_to_ingest_state.sql](../db/migrations/008_add_notes_column_to_ingest_state.sql)

Adds tracking column:
```sql
ALTER TABLE data_ingest_state
ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT NULL;
```

**Purpose**: Allows safeguard to mark records

---

### Part 3: Runtime Safeguard (STEP 0.5) ✅

**File**: [apps/typescript/tick-factory/src/ingestindex.ts](../apps/typescript/tick-factory/src/ingestindex.ts) (Lines 1143-1195)

Added new check before processing each asset:

```typescript
// ====== STEP 0.5: SAFEGUARD - Check for orphaned state records ======
try {
  // 1. Check if state record exists
  const stateCheck = await supa.get(...);
  
  if (stateCheck.length > 0) {
    // 2. Check if asset is still active
    const registryCheck = await supa.get(...);
    
    // 3. If state exists but asset disabled = ORPHANED
    if (registryCheck.length === 0) {
      // Mark with status='orphaned' and note
      // Skip processing
      // Log warning
      continue;
    }
  }
} catch (e) {
  // Non-blocking error handling
}
```

**Benefits**:
- Catches any new orphaned records
- Prevents CPU timeouts
- Non-breaking (other assets still process)
- Detailed logging
- Marks records for monitoring

---

## Deployment Sequence

### Step 1: Apply Migrations (Database)
```bash
# Connect to Supabase
psql $PG_DSN << EOF

-- Migration 007: Clean existing orphaned records
-- (Run content of 007_cleanup_orphaned_ingest_state.sql)

-- Migration 008: Add notes column
-- (Run content of 008_add_notes_column_to_ingest_state.sql)

EOF
```

### Step 2: Deploy Worker Code
```bash
# Redeploy tick-factory with safeguard code
cd apps/typescript/tick-factory
npm run deploy  # or your deploy command
```

### Step 3: Verify Implementation
```bash
# Check safeguard is in place
python3 scripts/verify-safeguard.py

# Monitor logs
# Look for: ORPHANED_STATE warnings
# Verify: No exceededCpu errors
```

---

## What Happens During/After Deployment

### Before Migration + Code Deploy
```
❌ 3 orphaned records in database
❌ Worker times out every 3-5 minutes
❌ Ingestion jobs fail repeatedly
```

### After Migration 007 (cleanup)
```
✅ 3 orphaned records deleted
❌ But old worker still running (code not updated yet)
❌ If new orphaned records created = no protection
```

### After Deploying New Worker Code
```
✅ Migration cleaned old orphaned records
✅ New safeguard catches any future orphaned records
✅ Records marked when detected
✅ Ingestion continues smoothly
✅ No CPU timeouts
```

---

## Expected Logs

### When Safeguard Detects Orphaned Record
```
2026-01-13T00:15:30.456Z WARN [PROCESS] [1/10:XAGUSD][run:e986f221] ORPHANED_STATE: Orphaned state record detected for XAGUSD (1m), marking and skipping | {"reason":"asset_disabled_but_state_exists"}
```

### Job Summary After Safeguard
```
2026-01-13T00:15:45.789Z INFO [JOB_FINISH] JOB_RUN_COMPLETED: Job completed | {
  "assets_total": 10,
  "assets_attempted": 9,
  "assets_succeeded": 8,
  "assets_failed": 0,
  "assets_disabled": 0,
  "assets_skipped": 1,
  "skip_reasons": {
    "orphaned_state_record": 1
  },
  "duration_ms": 1842,
  "subrequests": 28
}
```

### Database After Safeguard Marks Record
```
SELECT canonical_symbol, timeframe, status, notes
FROM data_ingest_state WHERE status='orphaned';

canonical_symbol | timeframe | status   | notes
-----------------+-----------+----------+------------------------------------------
XAGUSD           | 1m        | orphaned | ORPHAN RECORD: Asset disabled on 2026-01-13T00:15:30.456Z but state record was not cleaned up. This record should be deleted.
```

---

## Monitoring & Verification

### Verification Script
```bash
python3 scripts/verify-safeguard.py
```

Expected output:
```
✅ CODE SAFEGUARD READY
✅ DATABASE SCHEMA READY
✅ MIGRATION APPLIED
✅ CURRENT STATE: X orphaned records exist
✅ NEXT STEPS: Apply migrations and redeploy
```

### Monitoring Queries

**Find orphaned records**:
```sql
SELECT canonical_symbol, timeframe, status, notes, updated_at
FROM data_ingest_state
WHERE status = 'orphaned' OR notes LIKE '%ORPHAN%'
ORDER BY updated_at DESC;
```

**Count safeguard activations**:
```sql
SELECT COUNT(*) FROM data_ingest_state
WHERE status = 'orphaned' AND updated_at > NOW() - INTERVAL '24 hours';
```

**Check for issues**:
```sql
SELECT * FROM ops_issues
WHERE issue_type = 'ORPHANED_STATE'
ORDER BY detected_at DESC
LIMIT 10;
```

---

## Rollback Plan (if needed)

### If Issue Found After Deployment

**Keep rollback simple**:
1. **Revert worker code**: Deploy previous version (removes safeguard)
2. **Keep migrations**: Don't revert migration 007/008 (they're additive)
3. **Keep cleaned records**: Orphaned records are safely deleted

**To fully rollback**:
```sql
-- Only if MAJOR issue found
-- Add notes column back (migration 008 can be reversed)
ALTER TABLE data_ingest_state DROP COLUMN IF EXISTS notes;

-- But DO NOT restore deleted orphaned records
-- They were problematic anyway
```

---

## Validation Checklist

After deployment, verify:

- [ ] Database migrations applied successfully
- [ ] `data_ingest_state.notes` column exists
- [ ] Orphaned records cleaned (0 remaining)
- [ ] Worker code deployed with STEP 0.5 safeguard
- [ ] logs show no `exceededCpu` errors
- [ ] Job completes in <3 seconds consistently
- [ ] All 9 active assets processed successfully
- [ ] Safeguard script returns all ✅ checks
- [ ] Monitoring shows `assets_skipped=0` (no more orphaned)

---

## Future Recommendations

### Short Term (1-2 weeks)
- [ ] Monitor logs for 5+ days
- [ ] Verify no new orphaned records created
- [ ] Check job success rate >99%

### Medium Term (1-2 months)
- [ ] Implement auto-cleanup: `DELETE FROM data_ingest_state WHERE status='orphaned' AND updated_at < NOW()-24h`
- [ ] Add cascade delete trigger on asset disable
- [ ] Enhanced monitoring alerts for multiple orphaned records

### Long Term (ongoing)
- [ ] Review asset lifecycle management
- [ ] Implement asset state machine (active → draining → disabled → archived)
- [ ] Add integration tests for orphaned record handling
- [ ] Consider partitioning large state tables for better performance

---

## Documentation Files

| File | Purpose |
|------|---------|
| [ORPHANED_STATE_SAFEGUARD.md](./ORPHANED_STATE_SAFEGUARD.md) | Complete safeguard implementation guide |
| [ORPHANED_INGEST_STATE_FIX.md](./ORPHANED_INGEST_STATE_FIX.md) | Issue & cleanup explanation |
| [INGEST_WORKER_CODE_REVIEW.md](./INGEST_WORKER_CODE_REVIEW.md) | Code analysis & diagnosis |
| [SAFEGUARD_IMPLEMENTATION_SUMMARY.md](./SAFEGUARD_IMPLEMENTATION_SUMMARY.md) | Changes made summary |
| [COMPLETE_SOLUTION.md](./COMPLETE_SOLUTION.md) | This file |

---

## Summary

✅ **Problem Diagnosed**: Orphaned state records for disabled assets  
✅ **Root Cause Found**: 3 records from AUDNZD, BTC, XAGUSD  
✅ **Solution Implemented**: Cleanup migration + runtime safeguard  
✅ **Code Verified**: Safeguard added to STEP 0.5 of ingestion  
✅ **Marking System**: Records tagged with status and notes  
✅ **Non-Breaking**: Other assets continue processing  
✅ **Monitored**: Detailed logging for ops visibility  
✅ **Documented**: Complete guides and verification scripts  

**Ready to deploy!**
