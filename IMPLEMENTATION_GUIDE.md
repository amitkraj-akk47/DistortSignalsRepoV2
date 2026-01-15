# Data Quality Validator - Implementation & Deployment Guide

This guide provides step-by-step instructions for implementing, testing, and deploying the data quality validation system.

## Phase 0: RPC Functions (Database Layer)

### Step 1: Deploy RPC Functions to Staging

```bash
# Navigate to project root
cd /workspaces/DistortSignalsRepoV2

# Apply migration
psql $SUPABASE_DEV_DB_URL < db/migrations/001_create_quality_validation_rpcs.sql

# Verify functions were created
psql $SUPABASE_DEV_DB_URL <<EOF
SELECT proname, pg_get_functiondef(pg_proc.oid)
FROM pg_proc
WHERE proname LIKE 'rpc_check_%'
ORDER BY proname;
EOF
```

### Step 2: Test Each RPC Function Individually

Test each of the 9 RPC functions in order:

```bash
# Test 1: rpc_check_staleness
psql $SUPABASE_DEV_DB_URL <<EOF
SELECT rpc_check_staleness('dev', 20, 5, 15) as result \gx
EOF

# Test 2: rpc_check_architecture_gates (HARD_FAIL check)
psql $SUPABASE_DEV_DB_URL <<EOF
SELECT rpc_check_architecture_gates('dev') as result \gx
EOF

# Test 3: rpc_check_duplicates
psql $SUPABASE_DEV_DB_URL <<EOF
SELECT rpc_check_duplicates('dev', 7) as result \gx
EOF

# Test 4: rpc_check_dxy_components
psql $SUPABASE_DEV_DB_URL <<EOF
SELECT rpc_check_dxy_components('dev', 7, 'strict') as result \gx
EOF

# Test 5: rpc_check_aggregation_reconciliation_sample
psql $SUPABASE_DEV_DB_URL <<EOF
SELECT rpc_check_aggregation_reconciliation_sample('dev', 7, 50, '{"rel_high_low": 0.0001}'::jsonb) as result \gx
EOF

# Test 6: rpc_check_ohlc_integrity_sample
psql $SUPABASE_DEV_DB_URL <<EOF
SELECT rpc_check_ohlc_integrity_sample('dev', 7, 5000, 0.10) as result \gx
EOF

# Test 7: rpc_check_gap_density
psql $SUPABASE_DEV_DB_URL <<EOF
SELECT rpc_check_gap_density('dev', 4, 10) as result \gx
EOF

# Test 8: rpc_check_coverage_ratios
psql $SUPABASE_DEV_DB_URL <<EOF
SELECT rpc_check_coverage_ratios('dev', 4, 95.0) as result \gx
EOF

# Test 9: rpc_check_historical_integrity_sample
psql $SUPABASE_DEV_DB_URL <<EOF
SELECT rpc_check_historical_integrity_sample('dev', 12, 10000, 0.10) as result \gx
EOF
```

**Expected Results:**
- All 9 functions return JSONB with status (pass|warning|critical|HARD_FAIL|error)
- Execution times should be within SLA targets (documented in RPC specs)
- No connection errors

### Step 3: Deploy Schema Changes (quality_data_validation table)

```bash
# This should have been created by the main schema migration
# Verify the table exists:
psql $SUPABASE_DEV_DB_URL <<EOF
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'quality_data_validation'
ORDER BY ordinal_position;
EOF
```

---

## Phase 1: Worker Project Setup

### Step 1: Install Dependencies

```bash
cd apps/typescript/data-quality-validator
npm install
# or
pnpm install
```

### Step 2: Configure Hyperdrive Binding

1. **Get Connection Pool ID from Supabase:**
   - Go to Supabase Dashboard → Your Project → Database
   - Click "Connection Pooling"
   - Copy the **Connection Pool** ID (format: `sql_dev_abcxyz...`)
   - Note the pool mode (recommended: Transaction)

2. **Update `wrangler.toml`:**
   ```toml
   [[hyperdrive]]
   id = "HYPERDRIVE_DEV"
   binding = "HYPERDRIVE"
   # Set the connection pool ID:
   # Replace with actual pool ID from Supabase
   ```

3. **Test Connection (Local):**
   ```bash
   npm run build
   npm run start
   # In another terminal:
   curl http://localhost:8787/health
   ```
   Expected response:
   ```json
   {
     "status": "ok",
     "environment": "development",
     "timestamp": "2026-01-14T10:30:00Z"
   }
   ```

### Step 3: Test Manual Triggers (Development)

```bash
# Terminal 1: Start local dev server
npm run start

# Terminal 2: Test endpoints
# Manual validation
curl -X POST http://localhost:8787/validate

# Fetch results (should be empty initially)
curl http://localhost:8787/results

# Fetch alerts
curl http://localhost:8787/alerts
```

---

## Phase 2: Staging Deployment

### Step 1: Deploy to Cloudflare Staging

```bash
# Configure staging Hyperdrive pool ID in wrangler.toml
# [[hyperdrive]] section with HYPERDRIVE_DEV binding

npm run build
npm run deploy:staging

# Verify deployment
curl https://your-staging-worker-domain.workers.dev/health
```

### Step 2: Test Manual Triggers in Staging

```bash
# Trigger validation manually
curl -X POST https://your-staging-worker-domain.workers.dev/validate

# Wait 30 seconds for execution
sleep 30

# Fetch results
curl https://your-staging-worker-domain.workers.dev/results?limit=10

# Check HARD_FAIL alerts (if any)
curl https://your-staging-worker-domain.workers.dev/alerts
```

### Step 3: Monitor Execution Duration

Run manual triggers and observe execution_duration_ms:

```bash
for i in {1..5}; do
  echo "Run $i:"
  curl -s https://your-staging-worker-domain.workers.dev/results?limit=1 | jq '.results[] | {check_category, status, execution_duration_ms}'
  sleep 5
done
```

**Success Criteria:**
- Quick health RPCs: each < 2s individual, total < 15s
- Daily correctness RPCs: each within SLA, total < 25s
- Weekly deep RPCs: each within SLA, total < 30s

---

## Phase 3: 7-Day Parallel Validation (Pre-Cutover)

### Step 1: Enable Worker in Staging (Cron Disabled)

Deploy Worker to staging with cron triggers disabled (manual-only mode).

### Step 2: Run Manual Triggers Daily

Run daily manual triggers alongside Python validation script:

```bash
# Every day at 3 AM UTC + 1 min (to avoid conflicts with Python):
# Worker trigger
curl -X POST https://your-staging-worker-domain.workers.dev/validate

# Python script also runs at 3 AM UTC (keeps running)
# They both write to separate tables for comparison
```

### Step 3: Create Comparison Query

Compare Python results vs Worker results:

```sql
-- Comparison: Python validation_results vs Worker quality_data_validation
SELECT 
  'Python' as source,
  check_type as check_category,
  status,
  COUNT(*) as count,
  MAX(execution_time_ms) as max_duration_ms,
  run_timestamp::DATE as date
FROM validation_results  -- Python table
WHERE env_name = 'dev'
  AND run_timestamp > NOW() - INTERVAL '7 days'
GROUP BY check_type, status, run_timestamp::DATE

UNION ALL

SELECT 
  'Worker' as source,
  check_category,
  status,
  COUNT(*) as count,
  MAX(execution_duration_ms) as max_duration_ms,
  run_timestamp::DATE as date
FROM quality_data_validation  -- Worker table
WHERE env_name = 'dev'
  AND run_timestamp > NOW() - INTERVAL '7 days'
GROUP BY check_category, status, run_timestamp::DATE

ORDER BY date DESC, source;
```

### Step 4: Success Criteria

Results should match within ±5% variance:

- ✅ Same status (pass/warning/critical) for same checks
- ✅ Similar issue counts (within 5%)
- ✅ Worker execution time < Python time (faster is OK)
- ✅ No HARD_FAIL discrepancies
- ✅ DXY component results aligned

If variance > 5%, investigate before cutover.

---

## Phase 4: Production Deployment

### Step 1: Finalize Configuration

```bash
# Update wrangler.toml with PRODUCTION Hyperdrive pool ID
# [[hyperdrive]]
# id = "HYPERDRIVE_PROD"
# binding = "HYPERDRIVE"
```

### Step 2: Deploy to Production

```bash
npm run deploy:prod

# Verify deployment
curl https://your-production-worker-domain.workers.dev/health
```

### Step 3: Enable Cron Triggers

Once deployed and verified:

```bash
# Manual test of first quick_health run
curl -X POST https://your-production-worker-domain.workers.dev/validate

# Wait for cron to trigger automatically at next :03 minute
# Monitor results:
curl https://your-production-worker-domain.workers.dev/results?limit=10
```

### Step 4: Disable Python Script (Cutover)

Once Worker cron is running reliably for 24h:

```bash
# Stop Python validation cron job
# (command depends on your scheduling system)
# e.g., comment out validation cron in main codebase

# Verify no duplicate data in quality_data_validation table:
psql $SUPABASE_PROD_DB_URL <<EOF
SELECT 
  run_timestamp::DATE as date,
  COUNT(*) as total_records,
  COUNT(DISTINCT run_id) as unique_runs
FROM quality_data_validation
WHERE env_name = 'prod'
  AND run_timestamp > NOW() - INTERVAL '1 day'
GROUP BY run_timestamp::DATE;
EOF
```

---

## Monitoring & Maintenance

### Daily Operations

**Dashboard Queries (Set up in your BI tool):**

1. **Status Overview (latest per check):**
   ```sql
   SELECT 
     check_category,
     status,
     issue_count,
     execution_duration_ms,
     run_timestamp
   FROM quality_data_validation
   WHERE env_name = 'prod'
   QUALIFY ROW_NUMBER() OVER (PARTITION BY check_category ORDER BY run_timestamp DESC) = 1
   ORDER BY check_category;
   ```

2. **7-Day Trend:**
   ```sql
   SELECT 
     check_category,
     status,
     COUNT(*) as count,
     ROUND(AVG(execution_duration_ms)) as avg_duration_ms,
     MAX(issue_count) as max_issues
   FROM quality_data_validation
   WHERE env_name = 'prod'
     AND run_timestamp > NOW() - INTERVAL '7 days'
   GROUP BY check_category, status
   ORDER BY check_category, count DESC;
   ```

3. **HARD_FAIL Alerts:**
   ```sql
   SELECT * FROM quality_data_validation
   WHERE env_name = 'prod'
     AND severity_gate = 'HARD_FAIL'
   ORDER BY run_timestamp DESC
   LIMIT 100;
   ```

### Weekly Operations

- [ ] Review execution duration trends (SLA compliance)
- [ ] Check issue_count trends (increasing = data quality degradation)
- [ ] Verify 0 HARD_FAIL alerts in steady state
- [ ] Monitor Postgres connection pool usage

### Monthly Operations

- [ ] Profile weekly deep validation execution time
- [ ] If avg < 20s, increase window_weeks from 4 → 8 or 12
- [ ] Review DXY tolerance mode appropriateness
- [ ] Adjust retention policy if storage grows > expected

### Performance Scaling Strategy

**Weekly Deep Expansion (4 weeks → 12 weeks over 8 weeks):**

```
Week 1-3: Monitor 4-week window (baseline)
  └─ Target: < 30 seconds

Week 4-6: Expand to 8-week window
  └─ If avg < 25s, continue
  └─ If avg > 30s, revert to 4-week

Week 7-10: Attempt 12-week window
  └─ If avg < 25s, finalize
  └─ If avg > 30s, stay at 8-week
```

---

## Troubleshooting

### Worker Not Executing

**Symptom:** Cron triggers not firing

**Solution:**
1. Check Cloudflare Workers logs: `wrangler tail`
2. Verify cron syntax in wrangler.toml
3. Check Worker is deployed: `wrangler list`

### Hyperdrive Connection Error

**Symptom:** "Hyperdrive binding not configured"

**Solution:**
1. Verify pool ID is set in wrangler.toml
2. Verify pool is active in Supabase Dashboard
3. Test connection: `curl https://worker-domain.workers.dev/health`
4. Check Cloudflare Worker secrets: `wrangler secret list`

### RPC Timeout

**Symptom:** RPC returns error with "timeout" message

**Solution:**
1. Check Postgres slow query log: `SELECT * FROM pg_stat_statements ORDER BY mean_exec_time DESC;`
2. Verify indexes exist on data_bars and derived_data_bars
3. Check Postgres connection load: `SELECT count(*) FROM pg_stat_activity;`
4. Reduce window_weeks for weekly deep validation

### HARD_FAIL Not Going Away

**Symptom:** Consistent HARD_FAIL in rpc_check_architecture_gates

**Issue:** 1m rows exist in derived_data_bars (architectural violation)

**Solution:**
```sql
-- Find and remove 1m rows from derived_data_bars
SELECT COUNT(*) FROM derived_data_bars WHERE timeframe = '1m';
DELETE FROM derived_data_bars WHERE timeframe = '1m';

-- Verify fix
SELECT rpc_check_architecture_gates('prod') as result \gx
```

---

## Rollback Plan

If critical issues occur post-cutover:

```bash
# Step 1: Disable Worker cron (disables automatic runs)
# Edit wrangler.toml, comment out [[triggers.crons]] sections, redeploy

# Step 2: Re-enable Python script
# Uncomment Python validation cron job in main codebase

# Step 3: Investigate issue
# Check Worker logs, RPC execution times, Postgres health

# Step 4: After fix, re-enable Worker
# Uncomment cron triggers, redeploy, run 7-day parallel again

# Step 5: Verify alignment before final cutover
```

---

## Success Checklist

- [ ] All 9 RPC functions deployed and tested individually
- [ ] Hyperdrive connection pool ID configured (dev and prod)
- [ ] Worker code builds without errors
- [ ] Manual triggers work in staging
- [ ] Cron triggers execute on schedule
- [ ] Results visible in quality_data_validation table
- [ ] Dashboard queries return expected results
- [ ] 7-day parallel run completed with < 5% variance
- [ ] No HARD_FAIL alerts in 24h baseline
- [ ] DXY tolerance mode selected and documented
- [ ] HARD_FAIL notification setup (optional Slack webhook)
- [ ] Python script disabled (cutover complete)
- [ ] Monitoring and alerting dashboard live

---

## References

- [RPC Function Specifications](../../docs/DATA_QUALITY_VALIDATION_WORKER_PLAN.md#phase-0-rpc-suite--explicit-specifications-blocking)
- [Hyperdrive Setup](https://developers.cloudflare.com/hyperdrive/)
- [Cloudflare Workers Cron Triggers](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Data Quality Validation Plan](../../docs/DATA_QUALITY_VALIDATION_WORKER_PLAN.md)
