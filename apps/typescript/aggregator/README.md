# Aggregator Worker

**Data Aggregation Cron Worker** - Production-ready Cloudflare Worker for aggregating raw tick data into higher timeframe OHLCV bars.

**Phase 5 Deployment**: Updated 2026-01-13 to use redesigned aggregation functions with unified start dates and mandatory task protection.

## Features

- ✅ Automated data aggregation from 1m/5m to higher timeframes
- ✅ Quality scoring for aggregated bars
- ✅ Distributed state management with soft-locking
- ✅ Automatic retry with transient error detection
- ✅ Per-task statistics and metrics tracking
- ✅ Auto-disable tasks after consecutive hard failures
- ✅ Comprehensive logging via ops_runlog
- ✅ CI/CD deployment via GitHub Actions

## Purpose

- Aggregates raw tick data (1m, 5m) into higher timeframes (15m, 1h, 4h, 1d)
- Maintains aggregation state and cursor positions per symbol/timeframe
- Runs every 5 minutes via Cloudflare Cron triggers
- Supports multiple environments (dev, test, stage, prod)

## Environment Variables

### Required Secrets (set via Cloudflare)
```env
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

### Configuration Variables (set in wrangler.toml)
```env
ENV_NAME=DEV
JOB_NAME=agg-master
MAX_TASKS_PER_RUN=20
MAX_WINDOWS_PER_TASK=100
RUNNING_STALE_SECONDS=900
AUTO_DISABLE_HARD_FAILS=3
AGG_DERIVATION_VERSION=1
LOG_LEVEL=INFO
```

## How It Works

1. **Task Selection**: Queries `agg_get_due_tasks` to find symbols/timeframes ready for aggregation
2. **Cursor Management**: Uses last aggregated bar timestamp as cursor, or bootstraps from source data
3. **Window Processing**: Aggregates up to MAX_WINDOWS_PER_TASK windows per task
4. **Quality Scoring**: Calculates quality score based on source candle completeness
5. **State Update**: Updates cursor position and task statistics
6. **Auto-Disable**: Disables tasks after AUTO_DISABLE_HARD_FAILS consecutive hard failures

## Development

```bash
# Install dependencies
pnpm install

# Run locally
pnpm dev

# Deploy to dev
pnpm deploy:dev

# Watch live logs
pnpm tail:dev
```

## Deployment

Automated via GitHub Actions on push to `main` branch.

Manual deployment:
```bash
# Deploy to specific environment
pnpm deploy:dev
pnpm deploy:test
pnpm deploy:stage
pnpm deploy:prod
```

## Monitoring

View logs in Cloudflare Dashboard:
https://dash.cloudflare.com/513f37da8020ee565269c199ff8bb52f/workers-and-pages

Or tail logs in real-time:
```bash
pnpm wrangler tail --env dev
```

## Database Functions

### Core RPC Functions Used:
- `agg_get_due_tasks` - Selects tasks ready for aggregation
- `agg_start` - Marks task as running and returns last cursor
- `agg_bootstrap_cursor` - Initializes cursor from source data
- `catchup_aggregation_range` - Performs the actual aggregation
- `agg_finish` - Updates state after success/failure
- `ops_runlog_start` - Logs run start
- `ops_runlog_checkpoint` - Logs execution checkpoints
- `ops_runlog_finish` - Logs run completion
- `ops_runlog_prune` - Cleans up old run logs

## Error Handling

### Transient Errors (retry eligible):
- Network timeouts
- Connection resets
- HTTP 429 (rate limits)
- Supabase PGRST301/PGRST302 errors

### Hard Errors (counted toward auto-disable):
- Invalid data
- Logic errors
- Missing source data
- Database constraint violations

## Architecture

This worker aggregates raw tick data into higher timeframe bars every 5 minutes via Cloudflare Cron triggers. It maintains state in Supabase and provides comprehensive logging for monitoring and debugging.

## Cron Schedule

Runs at: :01, :06, :11, :16, :21, :26, :31, :36, :41, :46, :51, :56 (every 5 minutes, starting at :01)
