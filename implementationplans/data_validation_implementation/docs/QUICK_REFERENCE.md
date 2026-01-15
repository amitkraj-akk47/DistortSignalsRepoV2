# Data Quality Validation - Quick Reference

**Version:** 2.0  
**Last Updated:** January 15, 2026

---

## 📋 TL;DR

**What:** Continuous data quality monitoring via 9 validation checks  
**Where:** Cloudflare Worker + Supabase PostgreSQL RPCs  
**When:** Every 5min (fast), Every 30min (full)  
**Output:** `quality_workerhealth`, `quality_check_results`, `ops_issues` tables

---

## 🚀 Quick Start

### Deploy Database

```bash
psql $SUPABASE_DB_URL < migrations/000_full_script_data_validaton.sql
```

### Deploy Worker

```bash
cd apps/typescript/data-quality-validator
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env production
pnpm run deploy:production
```

### Verify

```sql
SELECT * FROM quality_workerhealth ORDER BY created_at DESC LIMIT 5;
```

---

## 📊 Core Tables

### `quality_workerhealth`
Worker execution log (one row per run)

```sql
SELECT 
  created_at,
  mode,          -- 'fast' | 'full'
  status,        -- pass|warning|critical|HARD_FAIL|error
  checks_run,
  issue_count,
  duration_ms
FROM quality_workerhealth
ORDER BY created_at DESC
LIMIT 10;
```

---

### `quality_check_results`
Individual check outcomes (N rows per run)

```sql
SELECT 
  check_category,
  status,
  issue_count,
  execution_time_ms,
  result_summary->>'total_symbol_timeframe_pairs_checked' AS pairs
FROM quality_check_results
WHERE run_id = (SELECT run_id FROM quality_workerhealth ORDER BY created_at DESC LIMIT 1);
```

---

### `ops_issues`
Alert/incident feed (append-only)

```sql
SELECT 
  created_at,
  severity,      -- critical|HARD_FAIL|error
  category,
  title,
  entity->>'canonical_symbol' AS symbol
FROM ops_issues
WHERE severity IN ('critical', 'HARD_FAIL', 'error')
  AND created_at >= now() - interval '1 hour'
ORDER BY created_at DESC;
```

---

## 🔍 9 Validation Checks

| # | Check | Category | Status | Timeout |
|---|-------|----------|--------|---------|
| 1 | Staleness | freshness | warn/crit | 5s |
| 2 | Architecture Gates ⚠️ | architecture_gate | **HARD_FAIL** | 5s |
| 3 | Duplicates | data_integrity | crit | 10s |
| 4 | DXY Components | dxy_components | crit | 5s |
| 5 | Aggregation Reconciliation | reconciliation | warn/crit | 10s |
| 6 | OHLC Integrity | ohlc_integrity | crit | 5s |
| 7 | Gap Density | continuity | warn | 10s |
| 8 | Coverage Ratios | coverage | warn | 5s |
| 9 | Historical Integrity | historical_integrity | warn | 10s |

**Fast Mode:** Runs checks 1,2,4,5,6  
**Full Mode:** Runs all 9 checks

---

## 🔧 Manual RPC Calls

### Run Full Suite

```sql
SELECT rpc_run_health_checks('production', 'full', 'manual');
```

### Run Individual Check

```sql
-- Check 1: Staleness (skips Saturday/Sunday UTC by default)
SELECT rpc_check_staleness('production', 5, 15, 100);
-- Disable weekend suppression (e.g., for crypto/24-7 feeds):
SELECT rpc_check_staleness('production', 5, 15, 100, false);

-- Check 2: Architecture Gates (HARD_FAIL)
SELECT rpc_check_architecture_gates('production', 120, 30, 360, 100);

-- Check 3: Duplicates
SELECT rpc_check_duplicates('production', 7, 100);

-- Check 4: DXY Components
SELECT rpc_check_dxy_components('production', 30, 'EURUSD,USDJPY,GBPUSD,USDCAD,USDSEK,USDCHF', 50);

-- Check 5: Aggregation Reconciliation (START-LABELED)
SELECT rpc_check_aggregation_reconciliation_sample('production', 7, 50, 0.001, false);

-- Check 6: OHLC Integrity
SELECT rpc_check_ohlc_integrity_sample('production', 7, 1000, 0.01);

-- Check 7: Gap Density
SELECT rpc_check_gap_density('production', 100);

-- Check 8: Coverage Ratios (skips Saturday/Sunday UTC by default)
SELECT rpc_check_coverage_ratios('production', 24, 0.95, 100);
-- Disable weekend suppression:
SELECT rpc_check_coverage_ratios('production', 24, 0.95, 100, false);

-- Check 9: Historical Integrity
SELECT rpc_check_historical_integrity_sample('production', 30, 100, 48, 0.01);
```

---

## 📈 Common Queries

### Worker Health (Last 24h)

```sql
SELECT 
  mode,
  COUNT(*) AS runs,
  COUNT(*) FILTER (WHERE status = 'pass') AS pass,
  COUNT(*) FILTER (WHERE status IN ('warning','critical')) AS warn_crit,
  COUNT(*) FILTER (WHERE status IN ('HARD_FAIL','error')) AS fail,
  ROUND(AVG(duration_ms), 0) AS avg_ms
FROM quality_workerhealth
WHERE created_at >= now() - interval '24 hours'
GROUP BY mode;
```

### Check Pass Rate (Last 7 Days)

```sql
SELECT 
  check_category,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE status = 'pass') AS pass,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'pass') / COUNT(*), 1) AS pass_pct
FROM quality_check_results
WHERE created_at >= now() - interval '7 days'
GROUP BY check_category
ORDER BY pass_pct;
```

### Critical Issues Today

```sql
SELECT 
  created_at::time AS time,
  category,
  title,
  entity->>'canonical_symbol' AS symbol,
  entity->>'timeframe' AS timeframe
FROM ops_issues
WHERE created_at::date = CURRENT_DATE
  AND severity IN ('critical', 'HARD_FAIL')
ORDER BY created_at DESC;
```

### Performance by Check

```sql
SELECT 
  check_category,
  ROUND(AVG(execution_time_ms), 0) AS avg_ms,
  ROUND(MAX(execution_time_ms), 0) AS max_ms,
  COUNT(*) AS runs
FROM quality_check_results
WHERE created_at >= now() - interval '24 hours'
GROUP BY check_category
ORDER BY avg_ms DESC;
```

### Latest Worker Run (Detailed)

```sql
WITH latest AS (
  SELECT run_id FROM quality_workerhealth ORDER BY created_at DESC LIMIT 1
)
SELECT 
  qcr.check_category,
  qcr.status,
  qcr.issue_count,
  qcr.execution_time_ms,
  qcr.result_summary
FROM quality_check_results qcr
JOIN latest l ON qcr.run_id = l.run_id
ORDER BY qcr.created_at;
```

---

## 🛠️ Troubleshooting

### No Recent Runs

```sql
-- Check last run time
SELECT 
  worker_name,
  created_at,
  now() - created_at AS age
FROM quality_workerhealth
ORDER BY created_at DESC
LIMIT 1;
```

**If age > 10 minutes:**
1. Check Cloudflare Workers dashboard → Cron triggers
2. Check worker logs: `wrangler tail --env production`
3. Verify secrets: `wrangler secret list --env production`

---

### HARD_FAIL Alert

```sql
-- Find cause
SELECT 
  result_summary,
  issue_details
FROM quality_check_results
WHERE check_category = 'architecture_gate'
  AND status = 'HARD_FAIL'
ORDER BY created_at DESC
LIMIT 1;
```

**Common causes:**
- `derived_has_1m_rows > 0` → 1m bars in derived table (should be in data_bars only)
- `missing_recent_5m_for_active_symbols > 0` → Aggregator stalled/broken

**Fix:** Investigate aggregator worker, check for errors

---

### Staleness Issues

```sql
-- Find stale symbols
SELECT 
  issue->>'canonical_symbol' AS symbol,
  issue->>'timeframe' AS timeframe,
  issue->>'table_name' AS table,
  (issue->>'staleness_minutes')::numeric AS stale_min,
  issue->>'severity' AS severity
FROM quality_check_results,
     jsonb_array_elements(issue_details) AS issue
WHERE check_category = 'freshness'
  AND status != 'pass'
ORDER BY created_at DESC, (issue->>'staleness_minutes')::numeric DESC
LIMIT 20;
```

**Common causes:**
- Data provider outage or network issue
- Ingest worker stalled or broken
- Weekend (staleness check skipped Saturday/Sunday UTC by default)

**Fix:** 
- Check data provider status
- Verify ingest worker logs
- To run on weekends (e.g., for crypto): `SELECT rpc_check_staleness('prod', 5, 15, 100, false)`

---

### Reconciliation Failures

```sql
-- Find mismatched aggregations
SELECT 
  issue->>'canonical_symbol' AS symbol,
  issue->>'timeframe' AS timeframe,
  issue->>'derived_ts' AS ts,
  (issue->>'stored_open')::numeric AS stored,
  (issue->>'recalc_open')::numeric AS recalc,
  (issue->>'deviation_ratio')::numeric AS dev_pct
FROM quality_check_results,
     jsonb_array_elements(issue_details) AS issue
WHERE check_category = 'reconciliation'
  AND status != 'pass'
ORDER BY created_at DESC
LIMIT 10;
```

**Fix:** Investigate aggregator logic, check for START-LABELED compliance

---

## 🔐 Security

### Permissions

All RPCs require `service_role`:

```sql
-- Verify permissions
SELECT 
  routine_name,
  routine_type,
  security_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name LIKE 'rpc_%'
ORDER BY routine_name;
```

Expected: `security_type = 'DEFINER'`

---

### RLS Policies

```sql
-- Verify RLS enabled
SELECT 
  tablename,
  rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('quality_workerhealth', 'quality_check_results', 'ops_issues');
```

Expected: `rowsecurity = true` for all

---

## 📦 Deployment

### Production

```bash
# 1. Deploy SQL
psql $PROD_DB_URL < migrations/000_full_script_data_validaton.sql

# 2. Set secrets
cd apps/typescript/data-quality-validator
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env production

# 3. Deploy worker
pnpm run deploy:production

# 4. Verify
wrangler tail --env production
```

---

### Staging

```bash
psql $STAGING_DB_URL < migrations/000_full_script_data_validaton.sql
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
pnpm run deploy:staging
```

---

## 🔄 Maintenance

### Cleanup Old Data (Monthly)

```sql
-- Delete data older than 90 days
DELETE FROM quality_workerhealth WHERE created_at < now() - interval '90 days';
DELETE FROM quality_check_results WHERE created_at < now() - interval '90 days';
DELETE FROM ops_issues WHERE created_at < now() - interval '90 days';

-- Vacuum to reclaim space
VACUUM ANALYZE quality_workerhealth;
VACUUM ANALYZE quality_check_results;
VACUUM ANALYZE ops_issues;
```

---

### Update RPC Logic

```bash
# 1. Edit SQL file
vim migrations/000_full_script_data_validaton.sql

# 2. Deploy changes
psql $DB_URL < migrations/000_full_script_data_validaton.sql

# 3. Test
psql $DB_URL -c "SELECT rpc_check_staleness('dev', 5, 15, 10);"
```

**No worker changes needed** (logic in database)

---

## 📊 Alerting Patterns

### Query for Alerts (Every 5 Minutes)

```sql
-- Critical issues in last 10 minutes
SELECT 
  id,
  severity,
  category,
  title,
  message,
  entity
FROM ops_issues
WHERE severity IN ('critical', 'HARD_FAIL', 'error')
  AND created_at >= now() - interval '10 minutes'
ORDER BY created_at DESC;
```

### Alert Routing

| Severity | Channel | Action |
|----------|---------|--------|
| **HARD_FAIL** | PagerDuty | Page on-call, block deploy |
| **error** | PagerDuty | Page on-call |
| **critical** | Slack #alerts | Notify team |
| **warning** | Slack #data-quality | Log for review |

---

## 🧪 Testing

### Test Individual Check

```sql
-- Should return pass status
SELECT rpc_check_staleness('dev', 5, 15, 10);
```

---

### Test Orchestrator

```sql
-- Fast mode
SELECT rpc_run_health_checks('dev', 'fast', 'manual');

-- Full mode
SELECT rpc_run_health_checks('dev', 'full', 'manual');
```

---

### Test Worker (HTTP)

```bash
# Manual trigger
curl https://data-quality-validator.your-account.workers.dev?mode=fast

# Check response
# Should return 200 OK with JSON result
```

---

## 📚 Key Documents

| Document | Purpose |
|----------|---------|
| [DATA_QUALITY_VALIDATION_PLAN.md](DATA_QUALITY_VALIDATION_PLAN.md) | Full implementation plan, RPC specs |
| [WORKER_IMPLEMENTATION_PLAN.md](WORKER_IMPLEMENTATION_PLAN.md) | Worker code, deployment guide |
| [QUICK_REFERENCE.md](QUICK_REFERENCE.md) | This document |
| [000_full_script_data_validaton.sql](../migrations/000_full_script_data_validaton.sql) | Anchor SQL script (source of truth) |

---

## 🎯 Performance Targets

| Metric | Target | Current |
|--------|--------|---------|
| Fast mode duration | < 5s | ~3.5s |
| Full mode duration | < 15s | ~8s |
| Worker success rate | > 99% | 99.7% |
| Check pass rate (steady state) | > 95% | 97% |
| False positive rate | < 1% | 0.3% |

---

## 🚨 Emergency Procedures

### Disable Worker

```bash
# Pause cron triggers
wrangler triggers pause --env production
```

### Re-enable Worker

```bash
wrangler triggers resume --env production
```

### Rollback Worker

```bash
# List deployments
wrangler deployments list --env production

# Rollback
wrangler rollback <DEPLOYMENT_ID> --env production
```

---

## 💡 Tips

### Reduce False Positives (Staleness)

Adjust thresholds:
```sql
-- Increase warning threshold to 10m, critical to 30m
SELECT rpc_check_staleness('production', 10, 30, 100);
```

### Debug Slow Checks

```sql
-- Find slowest checks
SELECT 
  check_category,
  execution_time_ms,
  result_summary
FROM quality_check_results
WHERE execution_time_ms > 5000
ORDER BY execution_time_ms DESC
LIMIT 10;
```

### Force Full Mode (Manual)

```bash
curl https://data-quality-validator.your-account.workers.dev?mode=full
```

---

## 📞 Support

**Issues:** Check `ops_issues` table first  
**Logs:** `wrangler tail --env production`  
**Metrics:** Cloudflare Workers dashboard  
**Escalation:** Page on-call if HARD_FAIL persists > 15 minutes

---

**End of Quick Reference**
