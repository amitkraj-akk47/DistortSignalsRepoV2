# DXY Migration Plan - Feedback Incorporation & Critique Response

**Date**: January 13, 2025  
**Status**: Final revision complete  
**Document**: [DXY_MIGRATION_PLAN_FINAL.md](DXY_MIGRATION_PLAN_FINAL.md)

---

## Critical Feedback & Implementation

### 1. ✅ Avoided Over-Engineering of Asset Registry

**Feedback**: "Don't overbuild registry metadata now"

**Original Plan**: Complex per-asset thresholds, derivation versions, component weights

**Final Plan**:
```sql
-- Minimal registry update (Phase 3)
metadata: {
  'is_synthetic': true,
  'base_timeframe': '1m',
  'components': [...],
  'derived_timeframes': ['5m', '1h']
}
```

**Result**: Registry drives aggregation, nothing more. Clean and minimal.

---

### 2. ✅ Removed Embedded Verification Framework

**Feedback**: "Verification is a separate Worker. Don't embed it in migration plan."

**Original Plan**: Phase 5 included "verification worker in manual mode", "verification logging table"

**Final Plan**: 
- Removed all verification framework from migration
- Phase 6 replaced with minimal health checks (3 SQL queries)
- Verification Worker runs independently on schedule (separate task)
- No new logging tables needed

**Result**: Migration plan is now isolated. Verification is orthogonal.

---

### 3. ✅ Reduced Testing Scope to Minimum

**Feedback**: "You don't need unit tests + integration tests + aggregator behavior + E2E. Too much scope drift."

**Original Plan**: 9 different test categories, separate test files, mock databases

**Final Plan** (Phase 6):
```sql
-- Test 1: Function produces rows
SELECT COUNT(*) FROM data_bars WHERE canonical_symbol='DXY' ...
-- Test 2: Aggregation continues
SELECT COUNT(*) FROM derived_data_bars WHERE canonical_symbol='DXY' AND timeframe='5m'
-- Test 3: Code compiles
pytest tests/test_dxy.py -v
```

**Result**: 3 checks, 5 minutes, no infrastructure needed.

---

### 4. ✅ Explicit Dual-Write Decision (Option B)

**Feedback**: "You need an explicit transition strategy. Option A (clean cutover) vs Option B (24h overlap)"

**Original Plan**: Sounded like hard cutover, no discussion of options

**Final Plan**:
- **Executive Decision**: Option B (24h safety margin)
- **Day 1**: New RPC writes to `data_bars`, keep old data in `derived_data_bars`
- **Day 2**: Aggregator reads from `data_bars` only, verify health
- **Day 3**: Soft-delete old `derived_data_bars` rows

**Result**: Explicit strategy, reversible if needed, no data loss risk.

---

### 5. ✅ Explicit Schema Constraints & Indexes

**Feedback**: "Must explicitly call out (canonical_symbol, timeframe, ts_utc) unique index, check constraint, columns"

**Original Plan**: Buried constraints in Phase 2, not standalone

**Final Plan**:
- **Phase 2**: Dedicated "Schema Validation" section
- Explicit checks for:
  - Unique index: `(canonical_symbol, timeframe, ts_utc)` ✓
  - Source constraint: `'synthetic'` allowed ✓
  - Columns: `raw`, `created_at`, `updated_at` ✓
- **If-check** script provided to fix missing indexes/columns

**Result**: Crystal clear prerequisites. No surprises during execution.

---

### 6. ✅ Real Rollback (Data State Included)

**Feedback**: "Rollback must be 'real' and include data-state decision. Choose: leave data or delete it."

**Original Plan**: Vague "revert code" rollback, no data decision

**Final Plan** (Phase 8):
```sql
-- Revert code (manually)

-- Option: Keep DXY 1m in data_bars (harmless, just ignored)
-- Option: Delete if you want total revert (need explicit choice)
-- Either way: Old data still in derived_data_bars
```

**Result**: Explicit choice, documented, reversible without data loss.

---

### 7. ✅ Tightened Phase Structure

**Feedback**: "Each phase should be minimal and focused. Remove exploratory work."

**Comparison**:

| Phase | Original | Final | Change |
|-------|----------|-------|--------|
| 1 | 30 min pre-flight | 15 min checks + backup | -50% |
| 2 | 45 min schema + functions | 25 min schema + function | -44% |
| 3 | 45 min data migration | 20 min copy + verify | -56% |
| 4 | 1-2 hr code updates | 30 min code changes | -67% |
| 5 | 1 hr testing | 20 min health checks | -67% |
| 6 | 1-2 hr deploy + monitoring | 30 min + 24h background | Async |
| **Total** | **5-7 hours** | **3-4 hours** | **-50%** |

**Result**: More focused, less exploration, tighter execution.

---

## Feedback Item Mapping

| Feedback Item | Original Status | Final Status | Location |
|---------------|-----------------|--------------|----------|
| Registry metadata too complex | ❌ Over-built | ✅ Minimal | Phase 3 |
| Verification embedded | ❌ Embedded | ✅ Removed | N/A (separate) |
| Testing scope too large | ❌ 9 categories | ✅ 3 checks | Phase 6 |
| No dual-write decision | ❌ Ambiguous | ✅ Option B | Executive Summary |
| Constraints not explicit | ❌ Buried | ✅ Dedicated section | Phase 2 |
| Rollback vague on data | ❌ Unclear | ✅ Explicit | Phase 8 |
| Phase structure loose | ❌ Long phases | ✅ Tight phases | All phases |

---

## Key Design Decisions Locked

### Decision 1: Source Value = 'synthetic'
- Keeps `source` field semantic (provider vs. derived)
- Details in `raw.kind='dxy'`
- Consistent with future synthetic assets

### Decision 2: Option B Transition (24h Safety)
- Reduces rollback risk to zero (old data always available)
- Gives 24h to verify before cleanup
- Costs 24h extra time, worth it for peace of mind

### Decision 3: Verification is Separate
- Migration plan doesn't embed it
- Verification Worker runs independently post-deploy
- No new logging/config tables in migration

### Decision 4: Asset Registry is Minimal
- Just: `is_synthetic`, `base_timeframe`, `components`, `derived_timeframes`
- No per-asset thresholds or complex config
- Future-proof but not over-specified

---

## Execution Checklist (Line-by-Line)

- [ ] **Phase 1**: Run pre-flight backup script (15 min)
- [ ] **Phase 2**: Run schema validation (10 min), fix if needed
- [ ] **Phase 3**: Create `calc_dxy_range_1m()` function, test (15 min)
- [ ] **Phase 4**: Copy historical data, verify counts (20 min)
- [ ] **Phase 5**: Update tick-factory, aggregator, registry (30 min)
- [ ] **Phase 6**: Run 3 health checks (20 min)
- [ ] **Phase 7**: Deploy code + restart workers (30 min)
- [ ] **Phase 8**: Monitor for 24 hours (check hourly)
- [ ] **Phase 9**: Soft-delete old data, cleanup (10 min)

**Total**: 3-4 hours execution + 24 hours monitoring

---

## What's NOT in This Plan (Intentionally)

### ❌ Verification Framework
(Separate worker-based system, built later)

### ❌ Complex Testing Suite
(Minimal smoke tests only)

### ❌ Automated Rollback
(Manual, but data-safe)

### ❌ Complex Asset Registry Config
(Minimal, extensible later)

### ❌ New Logging Tables
(Uses existing ops_runlog elsewhere)

---

## Differences from Original 7-Phase Plan

| Original | Final | Why |
|----------|-------|-----|
| 7 phases | 9 phases (but shorter) | More granular, easier to execute |
| 5-7 hour estimate | 3-4 hours | Removed scope drift |
| No explicit transition option | Option B decided | Risk reduction |
| Embedded verification | Verification separate | Cleaner architecture |
| 9 test categories | 3 health checks | Focused on migration only |
| Vague rollback | Explicit data decision | Production-grade |
| Complex registry metadata | Minimal registry | Future-proof without over-spec |

---

## Ready to Execute

**This plan is now**:
- ✅ Tighter (50% shorter)
- ✅ More focused (removed scope drift)
- ✅ Production-safe (Option B dual-write)
- ✅ Risk-reduced (explicit rollback)
- ✅ Operationally sound (minimal, clear phases)

**Next step**: Copy [DXY_MIGRATION_PLAN_FINAL.md](DXY_MIGRATION_PLAN_FINAL.md) into your runbook and execute Phase 1.
