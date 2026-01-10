# Tick-Factory DXY Integration Patch

## Problem Statement

The tick-factory worker currently ingests FX pairs (EURUSD, USDJPY, GBPUSD, USDCAD, USDSEK, USDCHF) but does NOT derive DXY 1m bars from them.

Without this integration, the aggregator cannot create DXY 5m and 1h bars because the source DXY 1m data doesn't exist in `derived_data_bars`.

## Solution

After successfully ingesting each FX pair, check if we have all 6 FX pairs for the same time window, then call `calc_dxy_range_derived` to generate DXY 1m bars.

## Implementation

### Step 1: Add DXY Tracking State

Add these variables at the beginning of `runIngestAB()` function (around line 990):

```typescript
// Track FX pairs for DXY derivation
const FX_PAIRS_FOR_DXY = new Set(['EURUSD', 'USDJPY', 'GBPUSD', 'USDCAD', 'USDSEK', 'USDCHF']);
const fxWindowsIngested: Map<string, Set<string>> = new Map(); // window_key -> Set<symbol>

function makeWindowKey(from: Date, to: Date): string {
  return `${toIso(from)}|${toIso(to)}`;
}
```

### Step 2: Track FX Ingestion After Success

After Step 7 (ingest_asset_finish success), add FX tracking logic:

**Location:** Right after line ~1434 (after `counts.assets_succeeded++`)

```typescript
counts.assets_succeeded++;
log.assetSuccess({ 
  bars: barRows.length, 
  inserted: upsertResult?.inserted ?? 0,
  updated: upsertResult?.updated ?? 0,
  newCursor,
});

// ====== DXY DERIVATION: Track FX ingestion ======
if (FX_PAIRS_FOR_DXY.has(canonical) && tf === '1m' && barRows.length > 0) {
  const windowKey = makeWindowKey(fromTs, safeTo);
  
  if (!fxWindowsIngested.has(windowKey)) {
    fxWindowsIngested.set(windowKey, new Set());
  }
  fxWindowsIngested.get(windowKey)!.add(canonical);
  
  const ingestedForWindow = fxWindowsIngested.get(windowKey)!;
  log.debug("DXY_TRACK", `FX pair ingested for window`, { 
    symbol: canonical, 
    window: windowKey,
    count: ingestedForWindow.size,
    pairs: Array.from(ingestedForWindow) 
  });
  
  // Check if we have all 6 FX pairs for this window
  if (ingestedForWindow.size === 6) {
    log.info("DXY_DERIVE_START", `All 6 FX pairs ready - deriving DXY`, { 
      window: windowKey,
      pairs: Array.from(ingestedForWindow) 
    });
    
    try {
      const dxyResult = await supa.rpc("calc_dxy_range_derived", {
        p_from_utc: toIso(fromTs),
        p_to_utc: toIso(safeTo),
        p_tf: "1m",
        p_derivation_version: 1,
      });
      trackSubrequest();
      
      if (dxyResult.success) {
        log.info("DXY_DERIVE_SUCCESS", `DXY derived successfully`, {
          window: windowKey,
          inserted: dxyResult.inserted || 0,
          updated: dxyResult.updated || 0,
          skipped: dxyResult.skipped_incomplete || 0,
        });
      } else {
        log.warn("DXY_DERIVE_WARN", `DXY derivation returned success=false`, { 
          window: windowKey 
        });
      }
    } catch (e: any) {
      const errMsg = e instanceof Error ? e.message : String(e);
      log.warn("DXY_DERIVE_ERROR", `DXY derivation failed (non-fatal)`, { 
        window: windowKey,
        error: errMsg 
      });
      
      // Optional: Create issue for tracking
      await opsUpsertIssueBestEffort(supa, issuesOn, {
        severity_level: 2,
        issue_type: "DXY_DERIVATION_FAILED",
        source_system: "ingestion",
        canonical_symbol: "DXY",
        component: "dxy_derivation",
        summary: `DXY derivation failed for window ${windowKey}`,
        description: errMsg,
        metadata: { window: windowKey, error: errMsg },
        related_job_run_id: runId,
      });
    }
  }
}

await sleep(100 + jitter(150));
```

### Step 3: Add DXY Stats to Summary

Update the final summary to include DXY derivation stats (around line 1460):

```typescript
log.info("DATA", `Data: ${counts.rows_written} rows written`, {
  rows_written: counts.rows_written,
  rows_inserted: counts.rows_inserted,
  rows_updated: counts.rows_updated,
  rows_rejected: counts.rows_rejected,
  http_429_count: counts.http_429,
});

// Add DXY summary
const totalDxyWindows = Array.from(fxWindowsIngested.values()).filter(s => s.size === 6).length;
if (totalDxyWindows > 0 || fxWindowsIngested.size > 0) {
  log.info("DXY", `DXY derivation attempted for ${totalDxyWindows}/${fxWindowsIngested.size} windows`);
}
```

## Alternative: Batch DXY at End (More Efficient)

Instead of deriving DXY immediately after each complete FX set, you could batch all DXY derivations at the end:

```typescript
// After the main asset loop, before job completion
if (fxWindowsIngested.size > 0) {
  log.setPhase("DXY_DERIVATION");
  let dxySuccess = 0;
  let dxyFailed = 0;
  
  for (const [windowKey, symbols] of fxWindowsIngested.entries()) {
    if (symbols.size === 6) {
      const [fromIso, toIso] = windowKey.split('|');
      
      try {
        const dxyResult = await supa.rpc("calc_dxy_range_derived", {
          p_from_utc: fromIso,
          p_to_utc: toIso,
          p_tf: "1m",
          p_derivation_version: 1,
        });
        trackSubrequest();
        
        if (dxyResult.success) {
          dxySuccess++;
        }
      } catch (e) {
        dxyFailed++;
        log.warn("DXY_DERIVE_ERROR", `Failed: ${windowKey}`);
      }
    }
  }
  
  log.info("DXY_COMPLETE", `DXY derivation complete`, { 
    success: dxySuccess, 
    failed: dxyFailed 
  });
}
```

## Testing

After deploying the patch:

1. **Monitor Logs:**
   ```bash
   cd apps/typescript/tick-factory
   pnpm tail:dev
   ```

2. **Look for DXY log messages:**
   - `DXY_TRACK` - FX pair tracked
   - `DXY_DERIVE_START` - All 6 pairs ready
   - `DXY_DERIVE_SUCCESS` - DXY bars created
   - `DXY_DERIVE_ERROR` - Problems (investigate)

3. **Verify DXY 1m data:**
   ```sql
   SELECT COUNT(*) as dxy_bars, 
          MIN(ts_utc) as earliest, 
          MAX(ts_utc) as latest,
          MIN(close) as min_price,
          MAX(close) as max_price
   FROM derived_data_bars
   WHERE canonical_symbol = 'DXY' 
     AND timeframe = '1m' 
     AND deleted_at IS NULL;
   ```

4. **Check recent DXY bars:**
   ```sql
   SELECT ts_utc, open, high, low, close, quality_score, source
   FROM derived_data_bars
   WHERE canonical_symbol = 'DXY' AND timeframe = '1m' AND deleted_at IS NULL
   ORDER BY ts_utc DESC
   LIMIT 20;
   ```

## Deployment

```bash
cd /workspaces/DistortSignalsRepoV2/apps/typescript/tick-factory
git add src/ingestindex.ts
git commit -m "feat(tick-factory): Add DXY 1m derivation after FX ingestion"
git push origin main
# GitHub Actions will auto-deploy
```

Or manual deployment:
```bash
pnpm deploy:dev
```

## Important Notes

1. **DXY only derives when ALL 6 FX pairs are available** for the same time window
2. **Non-fatal failures** - If DXY derivation fails, the job continues (doesn't affect FX ingestion)
3. **Subrequest tracking** - Each DXY RPC call counts as 1 subrequest
4. **Performance impact** - Minimal, ~100-200ms per window to derive DXY
5. **Order doesn't matter** - As long as all 6 FX pairs are ingested in the same run, DXY will be derived

## Rollback

If issues occur, you can disable DXY derivation by commenting out the DXY block or setting a feature flag.
