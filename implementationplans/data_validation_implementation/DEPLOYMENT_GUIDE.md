# Deployment Guide - Data Quality Validation System v2.0

**Date:** January 15, 2026  
**Status:** Ready for Deployment

---

## Overview

This guide covers the complete deployment process for the Data Quality Validation system, including:
- **Phase 1:** SQL Anchor Script Deployment ✅ (Step 1 COMPLETE)
- **Phase 2:** Worker Deployment via CI/CD
- **Phase 3:** Documentation & Monitoring

---

## Phase 1: SQL Anchor Script Deployment

### ✅ Step 1: COMPLETE
**Already executed:** `000_full_script_data_validaton.sql` successfully deployed to Supabase

### Step 2: Verification
Run these checks in Supabase SQL editor to confirm deployment success:

**Check 1: Verify Tables (should return 3 rows)**
```sql
SELECT table_name, COUNT(column_name) as column_count
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN ('quality_workerhealth', 'quality_check_results', 'ops_issues')
GROUP BY table_name
ORDER BY table_name;
```

**Check 2: Verify Indexes (should return 10 rows)**
```sql
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND indexname LIKE 'idx_%'
ORDER BY indexname;
```

**Check 3: Verify RPC Functions (should return 12 functions)**
```sql
SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_name LIKE 'rpc_%'
ORDER BY routine_name;
```

**Check 4: RLS Verification (should show all 3 tables with rowsecurity=true)**
```sql
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('quality_workerhealth', 'quality_check_results', 'ops_issues')
ORDER BY tablename;
```

**Check 5: Quick RPC Test**
```sql
-- Test staleness check (basic validation)
SELECT jsonb_pretty(
  rpc_check_staleness('production', 5, 15, 100, true)
) as test_result;
-- Expected: JSONB with status field
```

If all 5 checks pass ✅ → **Phase 1 Complete, proceed to Phase 2**

---

## Phase 2: Worker Deployment via CI/CD

### Prerequisites
- ✅ SQL script deployed (Phase 1)
- ✅ GitHub repository with CI/CD configured
- ✅ Cloudflare account with API token
- ✅ Supabase credentials available

### Secrets Required (Ensure these exist in GitHub)

Add/verify these in GitHub repository settings → Secrets and variables → Actions:

```
CLOUDFLARE_API_TOKEN      = [Your Cloudflare API token]
CLOUDFLARE_ACCOUNT_ID     = [Your Cloudflare account ID]
SUPABASE_URL              = [Your Supabase project URL]
SUPABASE_SERVICE_ROLE_KEY = [Your Supabase service_role key]
```

### Deployment Steps

**Step 1: Commit the updated worker code**

```bash
# Navigate to repo root
cd /workspaces/DistortSignalsRepoV2

# Stage changes
git add apps/typescript/data-quality-validator/
git add .github/workflows/deploy-data-quality-validator.yml

# Commit with clear message
git commit -m "deploy: data quality validator worker v2.0

- Update wrangler.toml: single cron */5 * * * *
- Update scheduler.ts: getModeFromTime() for fast/full mode logic
- Update index.ts: pass scheduledTime to orchestrator
- Add CI/CD workflow: deploy-data-quality-validator.yml
- Align with SQL orchestrator RPC (rpc_run_health_checks)

Features:
- Fast mode (5 checks) at :05, :10, :15, :20, :25, :35, :40, :45, :50, :55
- Full mode (9 checks) at :00, :30
- Resilient error handling via RPC exception handlers
- Weekend suppression for staleness/coverage checks
- Single cron scheduling (no overlap conflicts)"

# Push to main branch
git push origin main
```

**Step 2: Monitor Deployment**

GitHub Actions will automatically:
1. Deploy to DEV environment
2. Wait for DEV to complete
3. Deploy to PRODUCTION
4. Configure secrets for both environments

**Step 3: Verify Deployment**

Check GitHub Actions tab:
- Workflow: "Deploy Data Quality Validator Worker"
- Status: Should show ✅ for both DEV and PRODUCTION jobs

Check Cloudflare Dashboard:
- Two new workers should appear:
  - `data-quality-validator-development` (DEV environment)
  - `data-quality-validator-production` (PRODUCTION environment)

**Step 4: Verify Worker Execution**

Wait ~5 minutes for first cron trigger, then check logs:

```bash
# Development logs
wrangler tail --env development

# Production logs
wrangler tail --env production

# Expected output:
# [cron] Validation suite starting (env: prod, time: 2026-01-15T12:00:00Z)
# [cron] Suite "full" completed: pass (5847ms, 9 checks)
```

---

## Phase 3: Monitoring & Validation

### Immediate Checks (First 30 minutes)

**Check 1: Worker Health**
```sql
-- View recent worker runs
SELECT 
  created_at,
  mode,
  status,
  duration_ms,
  issue_count
FROM public.quality_workerhealth
ORDER BY created_at DESC
LIMIT 10;
```

**Check 2: Check Results**
```sql
-- View all check results from latest run
SELECT 
  check_category,
  status,
  issue_count,
  execution_time_ms
FROM public.quality_check_results
WHERE run_id = (
  SELECT run_id FROM public.quality_workerhealth 
  ORDER BY created_at DESC LIMIT 1
)
ORDER BY check_category;
```

**Check 3: Operations Issues**
```sql
-- View any issues flagged
SELECT 
  severity,
  category,
  title,
  created_at
FROM public.ops_issues
WHERE created_at >= now() - interval '1 hour'
ORDER BY created_at DESC;
```

**Check 4: Schedule Verification**
```sql
-- Count executions by mode (every 5 minutes)
-- After 1 hour: should have ~2 FULL modes (at :00, :30), rest FAST
SELECT 
  mode,
  COUNT(*) as count,
  MIN(created_at) as first_run,
  MAX(created_at) as last_run
FROM public.quality_workerhealth
WHERE created_at >= now() - interval '1 hour'
GROUP BY mode
ORDER BY mode;

-- Expected: FAST=10, FULL=2 after 1 hour
```

### Daily Monitoring

**Dashboard Query: Last 24h Summary**
```sql
SELECT 
  mode,
  COUNT(*) as runs,
  COUNT(*) FILTER (WHERE status = 'pass') as pass_count,
  COUNT(*) FILTER (WHERE status = 'HARD_FAIL') as hard_fail_count,
  ROUND(AVG(duration_ms), 0) as avg_duration_ms
FROM public.quality_workerhealth
WHERE created_at >= now() - interval '24 hours'
GROUP BY mode
ORDER BY mode;
```

**Alert Monitoring: HARD_FAIL Detection**
```sql
-- Monitor for architecture violations
SELECT 
  run_id,
  created_at,
  duration_ms,
  issue_count
FROM public.quality_workerhealth
WHERE status = 'HARD_FAIL'
  AND created_at >= now() - interval '24 hours'
ORDER BY created_at DESC;
```

---

## Rollback Procedure (If Needed)

### If Worker Deployment Fails

1. **Stop the cron schedule** (Cloudflare Dashboard)
   - Go to Workers → data-quality-validator-production
   - Disable cron triggers temporarily

2. **Investigate issue**
   ```bash
   wrangler tail --env production --format json | head -100
   ```

3. **If fixing code**
   ```bash
   # Fix the issue in code
   git commit -am "fix: [describe fix]"
   git push origin main
   # CI/CD will redeploy automatically
   ```

4. **If reverting entirely**
   ```bash
   git revert HEAD
   git push origin main
   # CI/CD will deploy reverted code
   ```

### If SQL Script Needs Rollback

**Option 1: Drop all quality objects**
```sql
-- CAUTION: This deletes all validation data
DROP FUNCTION IF EXISTS public.rpc_run_health_checks(text,text,text) CASCADE;
DROP FUNCTION IF EXISTS public.rpc_check_staleness(text,int,int,int,boolean) CASCADE;
DROP FUNCTION IF EXISTS public.rpc_check_architecture_gates(text,int,int,int,int) CASCADE;
-- ... (repeat for all RPC functions)
DROP TABLE IF EXISTS public.quality_workerhealth CASCADE;
DROP TABLE IF EXISTS public.quality_check_results CASCADE;
DROP TABLE IF EXISTS public.ops_issues CASCADE;
```

**Option 2: Manual restoration**
- Keep previous SQL script backed up
- Run old script if needed (with version naming)

---

## Deployment Checklist

- [ ] Phase 1 SQL deployment complete (Step 2 verification passed)
- [ ] GitHub secrets configured (4 secrets)
- [ ] Worker code updated with new scheduler
- [ ] Commit message clear and descriptive
- [ ] Changes pushed to main branch
- [ ] GitHub Actions workflow started automatically
- [ ] Both DEV and PROD deployments completed successfully
- [ ] Worker logs show successful cron triggers
- [ ] Database shows recent quality_workerhealth records
- [ ] No HARD_FAIL alerts in ops_issues
- [ ] Monitoring queries tested and working

---

## Performance Expectations

### Fast Mode (5-minute intervals, except :00 and :30)
- **Duration:** ~5-10 seconds
- **Checks:** 5 core validations
  1. Architecture gates
  2. Staleness
  3. DXY components
  4. Aggregation reconciliation
  5. OHLC integrity

### Full Mode (30-minute intervals, at :00 and :30)
- **Duration:** ~20-30 seconds
- **Checks:** All 9 validations (adds 4 more)
  6. Duplicates
  7. Gap density
  8. Coverage ratios
  9. Historical integrity

### Resource Usage
- **Worker CPU:** ~100-500ms per execution
- **Database:** ~5-60 second statement timeout (RPC specific)
- **Storage:** ~1KB per check result, ~100KB per day

---

## Troubleshooting

### Issue: Worker not executing

**Check 1: Cron trigger status**
```bash
wrangler deployments list --env production
```

**Check 2: Worker logs**
```bash
wrangler tail --env production --follow
```

**Check 3: GitHub Actions**
- Go to Actions tab
- Check "Deploy Data Quality Validator Worker" workflow
- Look for failed jobs or errors

### Issue: RPC calls failing

**Check 1: Database connectivity**
```sql
SELECT now();  -- Basic connectivity test
```

**Check 2: RPC execution manually**
```sql
SELECT rpc_run_health_checks('production', 'fast', 'manual');
```

**Check 3: Worker logs**
```bash
wrangler tail --env production | grep error
```

### Issue: Missing data in tables

**Check 1: Worker execution count**
```sql
SELECT COUNT(*) FROM public.quality_workerhealth 
WHERE created_at >= now() - interval '1 hour';
```

**Check 2: Check results**
```sql
SELECT COUNT(*) FROM public.quality_check_results
WHERE created_at >= now() - interval '1 hour';
```

---

## Support & Escalation

For issues during deployment:

1. **Check GitHub Actions logs** (most detailed)
2. **Check worker logs** with `wrangler tail`
3. **Test RPC manually** in Supabase SQL editor
4. **Review validation report**: `SQL_VALIDATION_REPORT.md`
5. **Check implementation plans** in `implementationplans/data_validation_implementation/`

---

**Status: Ready for Production Deployment** ✅

Next step: Commit and push to main branch to trigger CI/CD
