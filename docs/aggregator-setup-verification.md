# Aggregator Setup Verification Checklist

## ✅ Completed Tasks

### 1. Monorepo Structure
- [x] Created `package.json` with proper scripts (dev, deploy, tail, etc.)
- [x] Created comprehensive `README.md` with documentation
- [x] Created `tsconfig.json` for IDE support
- [x] Fixed `wrangler.toml` configuration
  - Fixed main entry point: `src/aggworker.ts`
  - Updated compatibility date to 2026-01-08
  - Added proper environment configurations (dev, test, stage, prod)
  - Configured cron schedule: every 5 minutes starting at :01

### 2. Worker Code
- [x] Reviewed `aggworker.ts` - code is production-ready
  - Proper error handling (transient vs hard failures)
  - State management via RPC functions
  - Comprehensive logging via ops_runlog
  - Auto-disable after consecutive hard failures
  - Quality scoring for aggregated bars

### 3. Database Functions (SQL Migrations)
- [x] Verified all RPC functions match worker expectations:
  - `ops_runlog_start` - Logs run start
  - `ops_runlog_checkpoint` - Logs execution checkpoints
  - `ops_runlog_finish` - Logs run completion
  - `ops_runlog_prune` - Cleans up old logs
  - `agg_get_due_tasks` - Selects tasks ready for aggregation
  - `agg_start` - Marks task as running
  - `agg_finish` - Updates state after success/failure
  - `agg_bootstrap_cursor` - Initializes cursor from source data
  - `catchup_aggregation_range` - Performs aggregation
  - `aggregate_1m_to_5m_window` - Aggregates 1m to 5m
  - `aggregate_5m_to_1h_window` - Aggregates 5m to 1h
  - `_upsert_derived_bar` - Upserts aggregated bars

### 4. CI/CD Pipeline
- [x] Created `.github/workflows/deploy-aggregator.yml`
  - Triggers on push to main (when aggregator files change)
  - Manual trigger support via workflow_dispatch
  - Deploys to DEV environment
  - Configures secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
  - Uses pnpm with caching for faster builds

### 5. Dependencies
- [x] Installed all monorepo dependencies
- [x] Verified wrangler can build the worker (dry-run test passed)

## 📋 Pre-Deployment Checklist

### Cloudflare Secrets (Required)
You need to configure these secrets in Cloudflare:

```bash
# Navigate to aggregator directory
cd apps/typescript/aggregator

# Set secrets for dev environment
echo "YOUR_SUPABASE_URL" | npx wrangler secret put SUPABASE_URL --env dev
echo "YOUR_SUPABASE_SERVICE_ROLE_KEY" | npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env dev
```

### GitHub Secrets (Required for CI/CD)
Ensure these secrets are set in GitHub repository settings:
- `CLOUDFLARE_API_TOKEN` - API token with Workers Edit permission
- `CLOUDFLARE_ACCOUNT_ID` - Your Cloudflare account ID (513f37da8020ee565269c199ff8bb52f)
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key for database access

### Database Setup
- [x] SQL migrations already run (as mentioned by user)
- [x] Seed data already created (as mentioned by user)
- [ ] Verify `data_agg_state` table has task configurations:
  ```sql
  SELECT canonical_symbol, timeframe, source_timeframe, 
         run_interval_minutes, status, next_run_at
  FROM data_agg_state
  ORDER BY canonical_symbol, timeframe;
  ```

## 🚀 Deployment Instructions

### Manual Deployment (Development)
```bash
cd /workspaces/DistortSignalsRepoV2

# Install dependencies if not already done
pnpm install

# Navigate to aggregator
cd apps/typescript/aggregator

# Deploy to dev environment
pnpm deploy:dev

# Watch logs
pnpm tail:dev
```

### Automatic Deployment (via GitHub Actions)
1. Push changes to `main` branch
2. GitHub Actions will automatically deploy to DEV environment
3. Monitor deployment in GitHub Actions tab

## 🔍 Testing & Verification

### 1. Check Worker Deployment
```bash
# View deployed workers
npx wrangler deployments list --env dev

# View worker details
npx wrangler deployments view <deployment-id> --env dev
```

### 2. Monitor Logs
```bash
# Tail live logs
pnpm tail:dev

# Or use wrangler directly
npx wrangler tail aggregator-dev
```

### 3. Verify Cron Execution
- Check Cloudflare dashboard for cron trigger execution
- Monitor `ops_runlog` table for run records:
  ```sql
  SELECT run_id, job_name, trigger, env_name, 
         started_at, finished_at, status, stats
  FROM ops_runlog
  ORDER BY started_at DESC
  LIMIT 10;
  ```

### 4. Verify Data Aggregation
```sql
-- Check aggregated bars
SELECT canonical_symbol, timeframe, ts_utc, 
       quality_score, source_candles, expected_candles
FROM derived_data_bars
WHERE deleted_at IS NULL
ORDER BY ts_utc DESC
LIMIT 20;

-- Check task state
SELECT canonical_symbol, timeframe, status, 
       last_agg_bar_ts_utc, hard_fail_streak, last_error
FROM data_agg_state
ORDER BY canonical_symbol, timeframe;
```

## 📊 Monitoring & Maintenance

### Key Metrics to Watch
1. **Run Success Rate**: Check `ops_runlog.status` distribution
2. **Quality Scores**: Monitor bars with `quality_score <= 0`
3. **Hard Failures**: Watch for tasks with increasing `hard_fail_streak`
4. **Processing Speed**: Monitor `stats.bars_created` per run

### Common Issues & Solutions
1. **No tasks selected**: 
   - Check `next_run_at` in `data_agg_state`
   - Verify asset is active in `core_asset_registry_all`

2. **Transient errors**:
   - Network timeouts - will auto-retry
   - Rate limits - will auto-retry

3. **Hard failures**:
   - Missing source data - check `data_bars` table
   - Invalid configuration - verify `data_agg_state` settings
   - After 3 consecutive hard failures, task is auto-disabled

## 🎯 Next Steps

1. **Deploy to DEV**:
   ```bash
   cd apps/typescript/aggregator
   pnpm deploy:dev
   ```

2. **Monitor First Run**:
   ```bash
   pnpm tail:dev
   ```

3. **Verify Database Updates**:
   - Check `ops_runlog` for run record
   - Check `derived_data_bars` for new bars
   - Check `data_agg_state` for cursor updates

4. **Test Other Environments** (when ready):
   ```bash
   pnpm deploy:test    # TEST environment
   pnpm deploy:stage   # STAGE environment
   pnpm deploy:prod    # PRODUCTION environment
   ```

## 📚 Documentation References

- [Aggregator README](apps/typescript/aggregator/README.md)
- [Tick Factory README](apps/typescript/tick-factory/README.md) (similar structure)
- [SQL Migrations](docs/temp/aggregatorsql)
- [Wrangler Config](apps/typescript/aggregator/wrangler.toml)
- [CI/CD Workflow](.github/workflows/deploy-aggregator.yml)
