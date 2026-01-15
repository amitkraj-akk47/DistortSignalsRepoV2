# Data Quality Validator - Quick Reference

## ⚠️ CRITICAL ARCHITECTURAL TRUTHS

```
1. DXY 1m lives in data_bars (NOT derived_data_bars)
2. DXY 5m/1h/1d live in derived_data_bars  
3. derived_data_bars must NEVER have timeframe='1m' rows (HARD_FAIL gate)
4. Use RPC pattern (3-6 calls per run, NOT dozens of queries)
5. Quality score model: 5 bars→2, 4→1, 3→0, <3→skip
```

---

## Validation Schedules (Conflict-Avoidant)

| Type | Cron | RPCs | Target Time |
|------|------|------|-------------|
| **Quick Health** | `3,18,33,48 * * * *` (every 15m, offset) | 3 | < 15s |
| **Daily Correctness** | `0 3 * * *` (3 AM UTC) | 6 | < 25s |
| **Weekly Deep** | `0 4 * * 0` (Sunday 4 AM) | 3 | < 28s |

**Why offset?**
- Ingestion runs every minute at :00
- Aggregation runs every 5 minutes at :00, :05, :10, :15, etc.
- Validator runs at :03, :18, :33, :48 to avoid contention

---

## The 6 Core RPCs

### Quick Health (3 RPCs)
1. **rpc_check_staleness** - All symbols, both tables, one call
2. **rpc_check_architecture_gate** - HARD_FAIL if derived has 1m
3. **rpc_check_duplicates** - Both tables in one scan

### Daily Add-ons (+3 RPCs)
4. **rpc_check_dxy_components** - DXY 1m components (uses data_bars!)
5. **rpc_check_aggregation_quality_sample** - Quality-score validation
6. **rpc_check_ohlc_integrity** - Sampled OHLC checks

### Weekly Deep (3 RPCs)
- **rpc_check_gap_density** - Long-term gap analysis
- **rpc_check_coverage_ratios** - Coverage over time
- **rpc_check_historical_integrity** - Sampled integrity

---

## Worker Entry Point (Simplified)

```typescript
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const runId = crypto.randomUUID();
    const validationType = determineValidationType(event.cron);
    
    let results = [];
    
    if (validationType === 'quick_health') {
      results = await Promise.all([
        callRPC(env, 'rpc_check_staleness', { p_env: 'PROD', p_window_minutes: 20 }),
        callRPC(env, 'rpc_check_architecture_gate', { p_env: 'PROD' }),
        callRPC(env, 'rpc_check_duplicates', { p_env: 'PROD', p_window_minutes: 20 }),
      ]);
    }
    // ... daily_correctness, weekly_deep
    
    await storeResults(env, runId, validationType, results);
  }
};
```

---

## Dashboard Queries (Essential 3)

### 1. Latest Status
```sql
SELECT DISTINCT ON (check_category, table_name, timeframe)
  check_category, status, issue_count, run_timestamp
FROM quality_data_validation
WHERE env_name = 'PROD'
ORDER BY check_category, table_name, timeframe, run_timestamp DESC;
```

### 2. DXY Health
```sql
SELECT check_category, timeframe, status, result_summary
FROM quality_data_validation
WHERE canonical_symbol = 'DXY'
  AND run_timestamp >= NOW() - INTERVAL '24 hours'
ORDER BY run_timestamp DESC;
```

### 3. Hard Fail Alert
```sql
SELECT * FROM quality_data_validation
WHERE severity_gate = 'HARD_FAIL'
  AND status != 'pass'
  AND run_timestamp >= NOW() - INTERVAL '1 hour'
ORDER BY run_timestamp DESC;
```

---

## Implementation Checklist

### Phase 1: Database (4-5 days)
- [ ] Create `quality_data_validation` table
- [ ] Create `quality_validation_runs` table
- [ ] Implement 6 core RPC functions
- [ ] Create janitor cleanup function
- [ ] Test RPCs directly in SQL client

### Phase 2: Worker (3-4 days)
- [ ] Init Cloudflare Worker project
- [ ] Configure wrangler.toml (crons, env vars)
- [ ] Implement RPC caller utility
- [ ] Implement result storage layer

### Phase 3: Integration (4-5 days)
- [ ] Wire up quick_health validation
- [ ] Wire up daily_correctness validation
- [ ] Wire up weekly_deep validation
- [ ] Add error handling & retry logic

### Phase 4: Testing (3-4 days)
- [ ] Unit tests for each validation type
- [ ] Integration tests against staging DB
- [ ] Load testing (full asset list)
- [ ] Staging deployment & verification

### Phase 5: Dashboard (2-3 days)
- [ ] Document 6 widget queries
- [ ] Create mockups/wireframes
- [ ] Test queries against prod data
- [ ] Plan UI implementation (future)

### Phase 6: Production (2-3 days)
- [ ] Deploy to production (crons disabled)
- [ ] Manual testing via /validate endpoint
- [ ] Enable cron triggers
- [ ] Monitor first 24 hours

---

## Failure Scenarios & Responses

| Scenario | Detection | Response |
|----------|-----------|----------|
| **Architecture gate fails** (1m in derived) | Every validation run | HARD_FAIL → Page ops → Stop aggregation → Investigate |
| **DXY components missing** | Every 15 min | CRITICAL → Investigate ingestion for component pairs |
| **Staleness > 15 min** | Every 15 min | CRITICAL → Check ingestion worker health |
| **Duplicates detected** | Every 15 min | WARNING/CRITICAL → Check for race conditions |
| **Aggregation quality low** (score 0-1) | Daily | WARNING → Acceptable if transient, investigate if persistent |
| **Worker execution timeout** | Cron monitoring | ERROR → Optimize RPC queries, increase timeout |

---

## Key Metrics to Watch

**Dashboard (Manual monitoring initially):**
- Latest run timestamp (should be < 15 min ago)
- Count of HARD_FAIL statuses (should be 0)
- DXY component availability (should be 100%)
- Staleness max across all symbols (should be < 5 min)
- Aggregation quality score distribution

**Ops Alerts (Manual checking):**
- Check `severity_gate = 'HARD_FAIL'` every hour
- Check DXY health before market open
- Review weekly deep results every Monday

---

## Common Issues & Fixes

### Issue: "RPC execution too slow"
- **Check:** Are indexes in place?
- **Fix:** Add indexes on (canonical_symbol, timeframe, ts_utc)

### Issue: "Architecture gate failing"
- **Check:** Is there a migration in progress?
- **Fix:** Clean up derived_data_bars WHERE timeframe='1m'

### Issue: "Worker subrequest limit"
- **Check:** Are you calling RPCs individually or in parallel?
- **Fix:** Use Promise.all() to parallelize RPC calls

### Issue: "DXY component check failing"
- **Check:** Is ingestion running for all 6 pairs?
- **Fix:** Restart ingestion worker, check pair configuration

---

## References

- Full Plan: [DATA_QUALITY_VALIDATION_PLAN_V1.1_COMPLETE.md](DATA_QUALITY_VALIDATION_PLAN_V1.1_COMPLETE.md)
- Original (corrected): [DATA_QUALITY_VALIDATION_WORKER_PLAN.md](DATA_QUALITY_VALIDATION_WORKER_PLAN.md)
- Python Scripts: `/scripts/verify_data.py`, `/scripts/diagnose_staleness.py`

---

**Last Updated:** 2026-01-14  
**Version:** 1.1
