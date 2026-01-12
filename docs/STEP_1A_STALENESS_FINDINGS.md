# Step 1A: Staleness Diagnostic Findings

**Date:** 2026-01-12  
**Status:** ⚠ WARNING - Staleness exceeds 8 minutes

---

## Executive Summary

Ingestion is **working but suboptimal**:
- ✓ Data is flowing consistently (60 bars/hour for most hours)
- ⚠ Current staleness: **8.8 minutes max, 5.8 minutes average**
- ⚠ Some assets (USDJPY, USDSEK) consistently lag behind others
- ⚠ Gaps detected in last 24 hours, largest being **61 minutes** (XAUUSD)

## Key Findings

### 1. Staleness by Asset (as of 2026-01-12 10:35 UTC)

| Asset | Latest Bar | Staleness | Status |
|-------|-----------|-----------|--------|
| USDJPY | 10:27:00 | 8.8 min | ⚠ WARNING |
| USDSEK | 10:27:00 | 8.8 min | ⚠ WARNING |
| XAUUSD | 10:28:00 | 7.8 min | ⚠ MINOR |
| EURUSD | 10:32:00 | 3.8 min | ✓ OK |
| USDCHF | 10:32:00 | 3.8 min | ✓ OK |
| GBPUSD | 10:32:00 | 3.8 min | ✓ OK |
| USDCAD | 10:32:00 | 3.8 min | ✓ OK |

**Pattern:** Assets split into two groups — 4 assets at ~4min staleness, 3 assets at ~8min staleness.

### 2. Ingestion Activity (Last 24 Hours)

- **Most hours:** 60 bars/asset/hour (perfect 1-min cadence) ✓
- **Current hour (10:00-10:35):** Only 28-33 bars/asset ⚠
- **Consistency:** Very good for hours 04:00-09:00

**Interpretation:** Ingestion **was working perfectly** until ~10:27 UTC, then appears to have paused or slowed.

### 3. Gaps Detected

13 gaps >5 minutes in last 24 hours:

| Asset | Gap Duration | Time |
|-------|-------------|------|
| XAUUSD | 61 minutes | 22:00-23:01 |
| Multiple | 25 minutes | 22:07-22:32, 22:32-22:57 |
| EURUSD | 19 minutes | 22:32-22:51 |
| Multiple | 7 minutes | 22:00-22:07 |

**Pattern:** Concentrated around **22:00-23:00 UTC** (6-7pm ET) — potential weekend rollover or provider maintenance.

---

## Root Cause Analysis

### Hypothesis 1: Cron Schedule Too Infrequent ⚠ LIKELY

If Worker runs every 5 minutes + 1-2 min API/processing lag = 6-7 min staleness.

**Evidence:**
- Assets staleness clusters around 3-4 min and 8-9 min
- Suggests Worker runs every ~3-5 minutes

**Solution:**
- Increase cron frequency to every **2 minutes**
- Target: <3 min staleness in steady state

### Hypothesis 2: Provider API Lag During Low Liquidity

Some assets consistently lag (USDJPY, USDSEK, XAUUSD).

**Evidence:**
- Asset-specific staleness pattern
- Gaps concentrated around 22:00-23:00 UTC

**Possible causes:**
- Provider delays for these specific assets
- Lower liquidity during certain hours
- Regional API routing delays

**Solution:**
- Review provider SLA for these assets
- Consider multi-provider fallback for critical assets

### Hypothesis 3: Worker Currently Paused/Failed

Current hour shows only ~30 bars/asset instead of expected 60.

**Evidence:**
- Perfect 60 bars/hour until 10:00 UTC
- Sudden drop to 28-33 bars at 10:00-10:35 UTC
- Suggests Worker may have stopped around 10:27-10:32 UTC

**Solution:**
- Check Cloudflare Worker logs immediately
- Verify cron trigger is active
- Check for deployment/restart events

---

## 📋 Action Plan (UPDATED with Concurrency Analysis)

### Phase 0: Lock & Concurrency Validation (COMPLETE ✅)
**Status**: COMPLETE  
**Analysis**: [WORKER_LOCK_AND_CONCURRENCY_ANALYSIS.md](WORKER_LOCK_AND_CONCURRENCY_ANALYSIS.md)

**Findings**:
- ✅ **Distributed lock verified**: Worker uses `ops_acquire_job_lock` RPC with 150s lease
- ✅ **Lock prevents overlap**: Multiple instances gracefully exit if lock held
- ✅ **Sequential processing confirmed**: `for...of` loop at [ingestindex.ts#L1066](../apps/typescript/tick-factory/src/ingestindex.ts#L1066)
- ✅ **Root cause identified**: Assets processed one-by-one, causing 8.8 min max staleness

**🚨 CRITICAL FINDING**:
- ⚠️ Lock lease is only 150s (2.5 min) but suspected runtime is 8-9 min
- ⚠️ If runtime > lease, lock expires mid-run → potential overlap risk
- ⚠️ Need immediate validation from Worker logs

**Architecture Safety**:
- Lock acquisition: [ingestindex.ts#L943-L963](../apps/typescript/tick-factory/src/ingestindex.ts#L943-L963)
- Lock guarantees single-instance execution IF runtime < 150s
- Lease-based expiry prevents zombie locks (auto-release after 150s)
- Lock released in `finally` block after completion

### Phase 0.5: Validate Runtime vs Lock Lease (COMPLETE ✅)
**Status**: COMPLETE  
**Validation Date**: 2026-01-12 11:35 UTC

**Findings from Worker Logs**:
- ✅ **Runtime**: 14.18 seconds (duration_ms: 14180)
- ✅ **Lock lease**: 150 seconds (plenty of headroom - runtime is 9.5% of lease)
- ✅ **Budget cap**: 85 seconds (MAX_RUN_BUDGET_MS: 85000)
- ✅ **Per-asset timing**: avg 1.6s, min 1.5s, max 1.9s (EURUSD)
- ✅ **Sequential overhead**: Minimal (3s out of 14s total)
- ✅ **Lock safety**: No risk of expiry or overlap

**Key Insight**: Worker runs in **14 seconds**, not 8-9 minutes as initially suspected.

**Root Cause Identified**: Staleness is caused by **cron frequency (*/5 = every 5 minutes)**, NOT Worker runtime or sequential processing.

**Implication**: Bounded concurrency is NOT needed. Fix is to increase cron frequency.

### Phase 1: Immediate Diagnostics (COMPLETE ✅)
**Status**: COMPLETE  
**Tools Created**: `diagnose_staleness.py`, `diagnose_staleness.sql`

**Findings**:
- Max staleness: 8.8 min (USDJPY, USDSEK)
- Avg staleness: 5.8 min (above 5 min SLA)
- Cohort pattern: 4 assets at ~4 min, 3 assets at ~8 min (confirms sequential processing)
- Recent gaps: 61-minute gap in XAUUSD at 22:00 UTC (likely weekend rollover)
- Worker pause: Only 28-33 bars/hour at 10:00-10:35 UTC instead of expected 60

**Market-Hours Context**:
- FX assets (EURUSD, GBPUSD, etc.): Trade 24/5 (Sunday 17:00 ET → Friday 17:00 ET)
- XAUUSD: Similar to FX (24-hour trading)
- Future assets (GLD, GDX, SLV, VIX): US market hours only (9:30-16:00 ET)

### Phase 2: Increase Cron Frequency (HIGH PRIORITY 🚨)
**Target**: Reduce staleness to <5 min (and ideally <2 min) by increasing ingestion frequency

**Root Cause Confirmed**: Staleness is caused by **cron schedule (*/5 = every 5 minutes)**, NOT Worker runtime
- Worker completes in **14 seconds** for 7 assets
- Cron runs every **300 seconds** (5 minutes)
- Data is idle **286 seconds** (95% of the time)
- Max staleness of 8.8 min is directly from 5-minute cron gaps

**Solution**: Increase cron frequency to */2 or */1

#### Step 2A: Deploy */2 Cron (Every 2 Minutes)
**File**: `wrangler.toml` or Cloudflare Dashboard

**Change**:
```toml
# Current
triggers = { crons = ["*/5 * * * *"] }

# New
triggers = { crons = ["*/2 * * * *"] }
```

**Expected Improvement**:
- Cron interval: 300s → **120s** (60% reduction)
- Max staleness: 8.8 min → **2.5-3.5 min** ✅ (meets <5 min SLA)
- Min staleness: 3.8 min → **1.5-2.5 min**
- Staleness spread: 5.0 min → **1.0-2.0 min**

**Safety Validation**:
- ✅ Runtime (14s) + buffer (10s) = 24s << 120s cron interval
- ✅ Lock lease (150s) >> cron interval (120s)
- ✅ Budget cap (85s) >> runtime (14s)
- ✅ No risk of overlap or contention

**Deployment**:
```bash
# Update cron in wrangler.toml
# Then deploy
wrangler deploy

# Monitor for 6 hours
watch -n 300 'python scripts/diagnose_staleness.py'
```

#### Step 2B: (Optional) Deploy */1 Cron (Every 1 Minute)
**If */2 is stable and want <2 min staleness**:

```toml
triggers = { crons = ["*/1 * * * *"] }
```

**Expected Improvement**:
- Cron interval: 120s → **60s** (50% further reduction)
- Max staleness: 2.5-3.5 min → **1.5-2.0 min** ✅✅ (stretch goal)
- Staleness spread: **<1 min** (very consistent)

**Caveats**:
- ⚠️ More aggressive subrequest usage (60 runs/hour vs 12 runs/hour)
- ⚠️ May hit Cloudflare rate limits if adding more assets
- ⚠️ Deploy only after validating */2 for 24 hours

#### Step 2C: Bounded Concurrency - NOT RECOMMENDED ❌
**Why not needed**:
- Current runtime: 14s for 7 assets (already fast)
- Sequential overhead: Only 3s (negligible)
- Max theoretical improvement: Save 2-3 seconds → 11-12s runtime
- **Impact on staleness**: Minimal (still limited by cron frequency)
- **Complexity**: High (refactor required, testing, potential bugs)
- **Risk/Reward**: Not justified

**Decision**: Skip bounded concurrency unless adding 10+ more assets

### Phase 3: Monitoring & Validation (PENDING)
**Target**: Sustained <3 min staleness with */2 cron, <2 min with */1 cron

**Actions**:
1. **Deploy */2 Cron** to test or production
2. **Monitor for 6 hours**:
   ```bash
   # Run diagnostics every 5 minutes
   watch -n 300 'python scripts/diagnose_staleness.py'
   ```
3. **Validate Metrics** (*/2 cron):
   - Max staleness <3 min (95th percentile) ✅
   - Asset staleness spread <1 min
   - No lock contention warnings
   - No increase in failed ingestion rate
   - Subrequest count reasonable (~24 per run × 30 runs/hour = 720/hour)
4. **If stable, consider */1 cron** (optional stretch goal)
5. **Monitor */1 for 24h** before declaring success

### Phase 4: Advanced Optimizations (OPTIONAL - Post-Backfill)
**Target**: Support 15+ assets without increasing staleness

**Potential Improvements** (if adding many assets):
1. **Bounded concurrency** (only if runtime exceeds 45s with more assets)
2. **Intelligent scheduling**: Prioritize assets with higher staleness
3. **Adaptive cron**: Adjust frequency based on market hours
4. **HTTP Keep-Alive**: Reuse connections to Massive API
5. **Multi-Region Workers**: Deploy to edge locations closer to provider

---

## Success Criteria (Step 1A Exit)

✅ **PASS when ALL are true:**

- [ ] Staleness < 5 minutes for all assets (7-day average during market hours)
- [ ] No gaps >5 minutes except during documented maintenance/weekends
- [ ] 55+ bars/asset/hour consistently
- [ ] All assets updating within 2 minutes of each other (no laggards)
- [ ] 24 consecutive hours of stable ingestion

**Current Status:** ❌ NOT MET — Need to increase cron frequency and fix current pause

---

## Next Steps

1. **Run diagnostics again in 1 hour** to check if staleness recovers
2. **If staleness persists >10 min:** Escalate to Cloudflare Worker emergency triage
3. **If staleness improves to 5-8 min:** Proceed with cron frequency increase
4. **Once stable <5 min for 24h:** Move to Step 1B (Report Fixes)

---

## Commands to Monitor Progress

```bash
# Re-run diagnostics
python scripts/diagnose_staleness.py

# Quick staleness check
python -c "
import os, psycopg2
from dotenv import load_dotenv
load_dotenv()
conn = psycopg2.connect(os.getenv('PG_DSN'))
cur = conn.cursor()
cur.execute(\"\"\"
  SELECT canonical_symbol, 
         EXTRACT(EPOCH FROM (NOW() - MAX(ts_utc))) / 60 as stale_min
  FROM data_bars WHERE timeframe='1m' GROUP BY 1 ORDER BY 2 DESC
\"\"\")
for row in cur: print(f'{row[0]:10} {row[1]:5.1f} min')
"
```

---

**Last Updated:** 2026-01-12 10:35 UTC  
**Next Review:** 2026-01-12 11:35 UTC (1 hour)
