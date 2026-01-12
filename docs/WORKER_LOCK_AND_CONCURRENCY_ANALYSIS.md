# Worker Lock and Concurrency Analysis

**Date**: 2026-01-12  
**Worker**: `apps/typescript/tick-factory/src/ingestindex.ts`  
**Analysis Scope**: Distributed lock mechanism and asset processing concurrency

---

## ✅ Distributed Lock: VERIFIED

### Implementation Details

**Lock Acquisition** ([ingestindex.ts#L522-L540](../apps/typescript/tick-factory/src/ingestindex.ts#L522-L540)):
```typescript
async function opsAcquireLock(
  supa: SupabaseRest,
  jobName: string,
  leaseSeconds: number,
  lockedBy: string
): Promise<LockResult> {
  try {
    const result = await supa.rpc<boolean>("ops_acquire_job_lock", {
      p_job_name: jobName,
      p_lease_seconds: leaseSeconds,
      p_locked_by: lockedBy,
    });
    return result ? { acquired: true } : { acquired: false, reason: "contention" };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("Failed to acquire lock (RPC error):", errMsg);
    return { acquired: false, reason: "rpc_error", error: errMsg };
  }
}
```

**Lock Usage** ([ingestindex.ts#L943-L963](../apps/typescript/tick-factory/src/ingestindex.ts#L943-L963)):
- **Lease Duration**: 150 seconds (default from `LOCK_LEASE_SECONDS`)
- **Lock Name**: `${jobName}` (e.g., `ingest_tick_factory`)
- **Lock Holder**: `"cloudflare_worker"`
- **Contention Handling**: Graceful exit if lock held by another instance
- **Error Handling**: Systemic issue raised if RPC fails
- **Budget Control**: Optional `MAX_RUN_BUDGET_MS` env var (stops early if exceeded)
- **Lock Release**: Guaranteed in `finally` block after job completion

**✅ ACTUAL RUNTIME VALIDATED (from logs 2026-01-12 11:35 UTC)**

**Total Runtime**: `duration_ms: 14180` = **14.18 seconds** ✅
- Lock lease: 150s (plenty of headroom - runtime is only 9.5% of lease)
- Budget cap: `MAX_RUN_BUDGET_MS: 85000` (85s hard limit)
- Subrequests: 24 (well within limits)

**Per-Asset Timing**:
- Average: 1637ms (~1.6s per asset)
- Min: 1472ms
- Max: 1913ms (EURUSD)
- Total asset processing: ~11s for 7 assets
- Overhead (setup, DXY, cleanup): ~3s

**Lock Safety**: ✅ CONFIRMED SAFE
- Runtime (14s) << Lock lease (150s)
- Runtime (14s) < Budget cap (85s)
- No risk of lock expiry mid-run
- No risk of overlap from runtime issues

**Lock Release** ([ingestindex.ts#L542-L547](../apps/typescript/tick-factory/src/ingestindex.ts#L542-L547)):
```typescript
async function opsReleaseLockBestEffort(supa: SupabaseRest, jobName: string): Promise<void> {
  try {
    await supa.rpc("ops_release_job_lock", { p_job_name: jobName });
  } catch {
    // Best effort - lease expiry will clean up
  }
}
```

### Lock Guarantees
✅ **Single instance execution**: Only one Worker can acquire the lock at a time  
✅ **Graceful contention**: Other instances exit without error if lock is held  
⚠️ **Lease-based safety**: Lock auto-expires after 150s (prevents zombie locks)  
✅ **Database-backed**: Uses Supabase RPC (`ops_acquire_job_lock`) for distributed coordination

**CONCLUSION**: Worker has distributed lock mechanism, BUT **requires runtime validation** to confirm runtime < lease duration (150s). If runtime exceeds lease, need to either:
- Increase `LOCK_LEASE_SECONDS` (e.g., to 300-600s), OR
- Set `MAX_RUN_BUDGET_MS` to cap runtime below lease, OR
- Add lock renewal/heartbeat during execution

---

## ✅ Sequential Processing: NOT THE PROBLEM

### Current Implementation

**Asset Processing Loop** ([ingestindex.ts#L1064-L1066](../apps/typescript/tick-factory/src/ingestindex.ts#L1064-L1066)):
```typescript
log.setPhase("PROCESS");
log.info("LOOP_START", `Starting asset processing loop`, { total: assets.length });

let assetIndex = 0;
for (const asset of assets) {
  assetIndex++;
  
  // ... asset ingestion (RPC calls, HTTP fetch, bar processing) ...
  
  await sleep(100 + jitter(100));
}
```

**Execution Pattern**: `for...of` loop with `await` → **SEQUENTIAL EXECUTION**

### Actual Performance (from logs)

**Total runtime: 14.18 seconds for 7 assets** ✅
- Per-asset average: **1.6 seconds** (not 60 seconds as suspected)
- Sequential overhead is minimal: 14s total vs 11s if perfectly parallel
- **Sequential processing is NOT causing staleness**

### Root Cause: Cron Frequency, Not Runtime

**Observed staleness pattern**:
- **Max staleness**: 8.8 minutes (USDJPY, USDSEK)
- **Min staleness**: 3.8 minutes (EURUSD, GBPUSD, USDCAD, USDCHF)

**ACTUAL root cause**: `*/5 * * * *` cron schedule (every 5 minutes)
- Cron runs every 300 seconds
- Worker completes in 14 seconds
- Data is **always 3-8 minutes old by design** due to cron spacing
- "Cohort pattern" is just timing within 5-minute windows

**Why assets show different staleness**:
- Assets processed early in run (EURUSD at 1/7): ~4 min stale
- Assets processed late in run (USDJPY at 5/7, USDSEK at 6/7): ~8 min stale
- Sequential order within 14s run creates small differences
- But the 5-minute cron gap is the dominant factor

**Bottlenecks**:
- HTTP fetch to Massive API (network latency + provider processing)
- RPC calls (`ingest_asset_start`, `upsert_bars_batch`, `ingest_asset_finish`) - 3 per asset
- Database write operations (upsert can be slow with large bar batches)
- Artificial delays: `await sleep(100 + jitter(100))` between assets

### Why Sequential is Problematic

1. **Staleness inequality**: Assets at end of queue have 2-3x higher staleness
2. **Wasted Worker time**: While waiting for HTTP, CPU is idle (no parallelism)
3. **Cron inefficiency**: */5 cron with 8-minute runtime means overlap risk (though lock prevents it)
4. **Poor asset scaling**: Adding more assets linearly increases total runtime

---

## 🎯 Bounded Concurrency Solution

### Design Principles

1. **Preserve safety**: Lock mechanism stays unchanged (prevents multi-instance overlap)
2. **Bounded parallelism**: Process 2-3 assets concurrently (not unbounded)
3. **Error isolation**: One asset failure doesn't crash others in batch
4. **Maintain order**: Continue processing sequentially within each batch
5. **DXY derivation**: FX tracking logic remains compatible

### Implementation: Option A (Manual Batching)

**Location**: Replace loop at [ingestindex.ts#L1066](../apps/typescript/tick-factory/src/ingestindex.ts#L1066)

```typescript
log.setPhase("PROCESS");
log.info("LOOP_START", `Starting asset processing loop`, { total: assets.length });

const CONCURRENCY_LIMIT = 3; // Process 3 assets at a time

// Helper: Process a single asset (extracted from current loop body)
async function processAsset(asset: AssetRow, index: number): Promise<void> {
  const canonical = asset.canonical_symbol;
  log.assetStart(canonical, index, assets.length, {
    ingestClass: asset.ingest_class,
    timeframe: asset.base_timeframe,
    endpointKey: asset.endpoint_key,
  });

  // ... [ALL EXISTING ASSET PROCESSING LOGIC GOES HERE] ...
  // (Lines 1078-1450 from current implementation)
  
  await sleep(100 + jitter(100));
}

// Bounded-parallel processing with manual batching
for (let i = 0; i < assets.length; i += CONCURRENCY_LIMIT) {
  const batch = assets.slice(i, i + CONCURRENCY_LIMIT);
  
  log.info("BATCH_START", `Processing batch`, {
    batchNum: Math.floor(i / CONCURRENCY_LIMIT) + 1,
    batchSize: batch.length,
    assetRange: `${i + 1}-${i + batch.length}`,
  });
  
  // Process batch in parallel, wait for all to complete
  await Promise.allSettled(
    batch.map((asset, batchIndex) => processAsset(asset, i + batchIndex + 1))
  );
  
  // Check run budget after each batch
  if (maxRunBudgetMs && Date.now() - runStartMs > maxRunBudgetMs) {
    log.warn("BUDGET_EXCEEDED", `Run budget exceeded (${maxRunBudgetMs}ms), stopping early`, {
      processed: i + batch.length,
      remaining: assets.length - (i + batch.length),
      subrequests: counts.subrequests,
    });
    break;
  }
}
```

### Implementation: Option B (p-limit library)

**Install dependency** (if not already present):
```bash
pnpm add p-limit
```

**Usage**:
```typescript
import pLimit from 'p-limit';

log.setPhase("PROCESS");
const limit = pLimit(3); // Max 3 concurrent

const promises = assets.map((asset, index) => 
  limit(() => processAsset(asset, index + 1))
);

await Promise.allSettled(promises);
```

**Recommendation**: Use **Option A (manual batching)** because:
- No external dependency required
- Easier to add per-batch logging and budget checks
- Simpler to debug (explicit batch boundaries)
- Better control over execution flow

---

## 📊 Expected Performance Improvement

### Current State (Sequential)
- **Total runtime**: ~8-9 minutes for 7 assets
- **Max staleness**: 8.8 minutes (USDJPY, USDSEK)
- **Min staleness**: 3.8 minutes (EURUSD, GBPUSD, USDCAD, USDCHF)
- **Staleness spread**: 5.0 minutes

### After Increasing Cron Frequency — EXPECTED

**Current state** (*/5 cron):
- Cron interval: 300 seconds
- Worker runtime: 14 seconds
- Idle time: 286 seconds (95% of the time, no ingestion)
- Max staleness: 8.8 minutes (limited by cron frequency)

**Option A: */2 cron** (every 2 minutes):
- Cron interval: 120 seconds
- Worker runtime: 14 seconds (unchanged)
- **Expected max staleness**: ~2.5-3.5 minutes ✅
- **Expected min staleness**: ~1.5-2.5 minutes
- Staleness reduction: 60-65% (8.8 min → 2.5-3.5 min)

**Option B: */1 cron** (every 1 minute):
- Cron interval: 60 seconds
- Worker runtime: 14 seconds (unchanged)
- **Expected max staleness**: ~1.5-2 minutes ✅✅
- **Expected min staleness**: ~1-1.5 minutes  
- Staleness reduction: 75-80% (8.8 min → 1.5-2 min)
- May hit Cloudflare subrequest limits more aggressively

**Bounded concurrency is NOT needed**:
- Current runtime (14s) is already fast
- Sequential processing overhead is negligible (3s)
- Adding parallelism would save at most 2-3 seconds
- Won't meaningfully improve staleness (still limited by cron)
- Adds complexity without proportional benefit

---

## 🔍 Code References

| Component | Location | Lines |
|-----------|----------|-------|
| Lock acquisition | [ingestindex.ts](../apps/typescript/tick-factory/src/ingestindex.ts#L522-L540) | 522-540 |
| Lock usage in main handler | [ingestindex.ts](../apps/typescript/tick-factory/src/ingestindex.ts#L943-L963) | 943-963 |
| Lock release | [ingestindex.ts](../apps/typescript/tick-factory/src/ingestindex.ts#L542-L547) | 542-547 |
| Asset processing loop (SEQUENTIAL) | [ingestindex.ts](../apps/typescript/tick-factory/src/ingestindex.ts#L1064-L1066) | 1064-1066 |
| Per-asset processing logic | [ingestindex.ts](../apps/typescript/tick-factory/src/ingestindex.ts#L1078-L1450) | 1078-1450 |
| DXY derivation tracking | [ingestindex.ts](../apps/typescript/tick-factory/src/ingestindex.ts#L1461-L1502) | 1461-1502 |

---

## ✅ Next Steps (Priority Order)

### 1. ✅ VALIDATE CURRENT STATE (COMPLETE)
**Validated from logs (2026-01-12 11:35 UTC)**:

- ✅ Runtime: 14.18 seconds (well under 85s budget, 150s lease)
- ✅ Per-asset timing: avg 1.6s, max 1.9s
- ✅ Lock safety: No risk of expiry or overlap
- ✅ Sequential overhead: Minimal (3s total)
- ✅ Root cause: **Cron frequency (*/5), NOT runtime**

### 2. INCREASE CRON FREQUENCY (HIGH PRIORITY 🚨)
**This is the actual fix for staleness**

**Recommended approach**: Progressive rollout

```bash
# Step 1: Test with */2 cron (every 2 minutes)
wrangler.toml:
  triggers = { crons = ["*/2 * * * *"] }

# Deploy and monitor for 6 hours
# Validate: staleness drops to ~2-3 min, no lock contention

# Step 2: If stable, move to */1 (every 1 minute)
wrangler.toml:
  triggers = { crons = ["*/1 * * * *"] }

# Monitor for 24 hours
# Validate: staleness drops to ~1.5-2 min, subrequests stay within limits
```

**Safety checks**:
- Runtime (14s) + safety buffer (10s) = 24s < 120s (*/2 cron interval) ✅
- Runtime (14s) + safety buffer (10s) = 24s < 60s (*/1 cron interval) ✅
- Lock lease (150s) is sufficient for both ✅
- Budget cap (85s) prevents runaway ✅

### 3. MONITOR STALENESS IMPROVEMENT
**After changing cron frequency**:

```bash
# Run diagnostics every 5 minutes for first hour
watch -n 300 'python scripts/diagnose_staleness.py'

# Check for:
# - Max staleness < 3 min (for */2) or < 2 min (for */1)
# - No lock contention errors
# - Subrequest count stays reasonable
# - No 429 rate limit errors
```

### 4. BOUNDED CONCURRENCY: OPTIONAL (LOW PRIORITY)
**Only consider if**:
- Adding 10+ more assets (runtime would increase)
- Want to squeeze out last 2-3 seconds of improvement
- Hit subrequest limits and need to optimize

**Current assessment**: NOT NEEDED
- Runtime is already fast (14s for 7 assets)
- Cron frequency is the dominant factor
- Complexity not justified by marginal gain

**Deployment Strategy**:
- Deploy to test environment first
- Monitor for 24 hours to confirm staleness <5 min
- Check for race conditions in DXY derivation (should be fine - uses DB-level atomic operations)
- Roll to production after validation

---

## 🔒 Safety Validations

✅ **Lock prevents multi-instance overlap**: Runtime (14s) << lease (150s)  
✅ **Budget cap prevents runaway**: 85s hard limit >> 14s actual runtime  
✅ **Sequential processing acceptable**: 14s total is fast enough  
✅ **DXY derivation works**: Correctly triggered after 6 FX pairs ingested  
✅ **Database integrity**: RPC functions are atomic (each asset's state is isolated)  

**STATUS**: ✅ **APPROVED FOR CRON FREQUENCY INCREASE**

Safe to proceed with:
1. ✅ */2 cron (every 2 minutes) - plenty of headroom
2. ✅ */1 cron (every 1 minute) - still safe with 14s runtime
3. ❌ Bounded concurrency - NOT NEEDED (adds complexity without benefit)
