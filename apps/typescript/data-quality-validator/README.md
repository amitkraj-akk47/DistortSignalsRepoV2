# Data Quality Validator Cloudflare Worker

Automated, continuous data quality validation using 9 specialized RPC functions against forex market data.

## Architecture Overview

This Cloudflare Worker implements a sophisticated data validation system with:

- **9 RPC Functions**: Specialized Postgres stored procedures for data quality checks
- **Three Validation Suites**:
  - Quick Health (every 15 minutes): Staleness, architecture gates, duplicates
  - Daily Correctness (3 AM UTC): Full validation including DXY components & aggregation
  - Weekly Deep (Sunday 4 AM UTC): Gap density, coverage ratios, historical integrity
- **Hyperdrive Transport**: Direct Postgres connection pooling (mandatory, not REST API)
- **JSONB Results Storage**: All results persisted to `quality_data_validation` table
- **Dashboard-First Monitoring**: No alerting system; all data available for custom dashboards

## Quick Start

### 1. Prerequisites

- Node.js 18+ and npm/pnpm
- Wrangler CLI 3.28+
- Supabase Hyperdrive configured with connection pool ID
- Access to Postgres database with schema already deployed

### 2. Environment Setup

```bash
cd apps/typescript/data-quality-validator

# Install dependencies
npm install

# Configure Hyperdrive binding (get pool ID from Supabase dashboard)
# Edit wrangler.toml and set HYPERDRIVE_DEV and HYPERDRIVE_PROD pool IDs
```

### 3. Deploy RPC Functions

Before deploying the Worker, deploy the RPC functions:

```bash
# Apply database migration
psql $DATABASE_URL < db/migrations/001_create_quality_validation_rpcs.sql

# Verify RPC functions exist
psql $DATABASE_URL -c "
  SELECT proname FROM pg_proc 
  WHERE proname LIKE 'rpc_check_%' 
  ORDER BY proname;
"
```

### 4. Deploy Worker

```bash
# Staging/Development
npm run deploy:staging

# Production
npm run deploy:prod
```

### 5. Manual Triggers (Testing)

```bash
# Manually trigger a validation suite
curl -X POST https://your-worker-domain/validate

# Fetch latest results
curl https://your-worker-domain/results?limit=50

# Fetch HARD_FAIL alerts
curl https://your-worker-domain/alerts?hours=1

# Health check
curl https://your-worker-domain/health
```

## Configuration

### Hyperdrive Binding (MANDATORY)

Update `wrangler.toml`:

```toml
[[hyperdrive]]
id = "HYPERDRIVE_DEV"
binding = "HYPERDRIVE"
# Pool ID from Supabase dashboard, e.g., "sql_dev_abc123xyz"
```

The Hyperdrive binding must be configured **before** deployment:

1. Go to Supabase Dashboard → Project → Database → Connection Pooling
2. Copy the connection pool ID (format: `sql_**_xyz`)
3. Set it in `wrangler.toml` or Cloudflare Workers settings

**Why Hyperdrive is mandatory:**
- 9 RPCs × multiple runs per day = ~4,400 Postgres connections/week
- REST API cannot handle connection pooling efficiency
- Direct Postgres (via Hyperdrive) = 1 RPC = 1 roundtrip, no subrequest overhead

### DXY Tolerance Mode (Configuration)

Adjust DXY component tolerance in `src/scheduler.ts`:

```typescript
// In runDailyCorrectnessValidation():
const result = await runDailyCorrectnessValidation(
  client,
  envName,
  'degraded'  // 'strict' | 'degraded' | 'lenient'
);
```

Tolerance modes:
- **strict** (6/6 required): Critical if < 6 components
- **degraded** (5/6 acceptable): Critical if ≤ 4/6 components
- **lenient** (3/6 minimum): Critical if < 3/6 components

### Performance Tuning (Weekly Deep)

The weekly deep validation is conservative by default (4-week window):

```typescript
// In runWeeklyDeepValidation():
const result = await runWeeklyDeepValidation(
  client,
  envName,
  4  // Start with 4 weeks, expand to 12 after profiling
);
```

To enable expansion:
1. Monitor execution times over 2-3 weeks
2. If avg < 20s and slowest RPC < 8s, increase to 8 weeks
3. After validation period, expand to 12 weeks

## Validation Suites

### Quick Health (Every 15 minutes at :03, :18, :33, :48)

**Duration target:** <15 seconds
**RPCs:** 3 (rpc_check_staleness, rpc_check_architecture_gates, rpc_check_duplicates)

```json
{
  "suite": "quick_health",
  "runId": "uuid",
  "status": "success|partial|failure",
  "totalDurationMs": 5000,
  "results": [
    {
      "validation_type": "quick_health",
      "check_category": "freshness",
      "status": "pass|warning|critical",
      "issue_count": 0,
      "execution_duration_ms": 1200
    }
  ]
}
```

### Daily Correctness (3 AM UTC)

**Duration target:** <25 seconds
**RPCs:** 6 (includes DXY components, aggregation reconciliation, OHLC integrity)

### Weekly Deep (Sunday 4 AM UTC)

**Duration target:** <30 seconds (conservative: 4-week window)
**RPCs:** 3 (gap density, coverage ratios, historical integrity)

**Performance Scaling:**
- Start: 4 weeks window
- Phase 1 (profiling): 2-3 weeks of monitoring
- Phase 2 (expansion): Increase to 8-12 weeks if SLA met

## RPC Function Details

All 9 RPC functions return standardized JSONB:

```json
{
  "status": "pass|warning|critical|HARD_FAIL|error",
  "check_category": "string",
  "issue_count": 0,
  "result_summary": { "...": "..." },
  "issue_details": [ {"...": "..."} ],
  "execution_time_ms": 1234
}
```

### HARD_FAIL Behavior

RPC 2 (`rpc_check_architecture_gates`) returns `HARD_FAIL` status if:
- Any `1m` rows exist in `derived_data_bars` (architectural violation)
- Ladder consistency gaps detected (5m exists without 1h, etc.)

**Handling:**
1. Result is ALWAYS written to `quality_data_validation` table
2. Worker returns non-success HTTP status (206 or 418)
3. Optional: Send minimal Slack webhook (one ping, no storm)
4. Dashboard-first: Ops team checks dashboard hourly

## Storage & Retention

Results stored in `quality_data_validation` table:

- **Retention:** 90 days (cleanup runs daily at 5 AM UTC)
- **Indexes:** Created on run_id, env_name, check_category, status, run_timestamp
- **Sampled Details:** Max 100 issue samples per RPC (to keep JSONB reasonable)

Query latest results:

```sql
SELECT * FROM quality_data_validation
WHERE env_name = 'prod'
  AND run_timestamp > NOW() - INTERVAL '1 hour'
ORDER BY run_timestamp DESC;
```

## Dashboard Integration

All data is accessible via simple queries:

1. **Latest Status Board:**
   ```sql
   SELECT DISTINCT ON (check_category) * 
   FROM quality_data_validation
   WHERE env_name = 'prod'
   ORDER BY check_category, run_timestamp DESC;
   ```

2. **Trend Chart (7-day history):**
   ```sql
   SELECT 
     check_category,
     date_trunc('hour', run_timestamp) as hour,
     status,
     COUNT(*) as count
   FROM quality_data_validation
   WHERE env_name = 'prod'
     AND run_timestamp > NOW() - INTERVAL '7 days'
   GROUP BY check_category, hour, status
   ORDER BY hour DESC;
   ```

3. **HARD_FAIL Alerts:**
   ```sql
   SELECT * FROM quality_data_validation
   WHERE env_name = 'prod'
     AND severity_gate = 'HARD_FAIL'
     AND run_timestamp > NOW() - INTERVAL '1 hour'
   ORDER BY run_timestamp DESC;
   ```

## Testing

### Test RPC Functions Locally

```bash
# Build TypeScript
npm run build

# Run integration test
npm run test:rpc
```

### Test Hyperdrive Connection

```bash
curl https://your-worker-domain/health
```

Expected response:
```json
{
  "status": "ok",
  "environment": "development|production",
  "timestamp": "2026-01-14T10:30:00Z"
}
```

## Troubleshooting

### Hyperdrive Connection Failed

1. Verify pool ID is correctly set in `wrangler.toml`
2. Confirm Supabase Hyperdrive is enabled for project
3. Check Cloudflare Workers logs: `wrangler tail`

### RPC Timeout

If RPC execution exceeds SLA:
- Check RPC logic in `db/migrations/001_create_quality_validation_rpcs.sql`
- Verify Postgres is responsive: `SELECT now();`
- Monitor Postgres slow query log

### Missing Results in Table

1. Verify `quality_data_validation` table exists
2. Check Worker execution logs
3. Confirm Hyperdrive has write permissions

## Production Checklist

Before cutting over to production:

- [ ] Hyperdrive pool ID confirmed in production environment
- [ ] RPC functions deployed and tested
- [ ] Worker deployed to production
- [ ] Manual triggers working (POST /validate)
- [ ] Results visible in `quality_data_validation` table
- [ ] Dashboard queries return results
- [ ] Cron triggers enabled (at least 1 quick_health run)
- [ ] Parallel run with Python scripts for 7 days (optional but recommended)
- [ ] DXY tolerance mode selected (strict/degraded/lenient)
- [ ] HARD_FAIL alerting configured (Slack webhook optional)

## Monitoring

**Key Metrics to Track:**

1. Execution duration per RPC (in `execution_duration_ms`)
2. HARD_FAIL frequency (should be zero in steady state)
3. Issue trend (should be stable or decreasing)
4. Total storage (90-day retention should stabilize ~50GB)

**SLA Targets:**
- Quick Health: < 15 seconds end-to-end
- Daily Correctness: < 25 seconds end-to-end
- Weekly Deep: < 30 seconds (conservative 4-week window)

## Architecture Diagrams

### Data Flow

```
Cron Trigger → Wrangler (scheduled event)
  ↓
Worker Code (index.ts)
  ↓
Hyperdrive Connection Pool
  ↓
9 RPC Functions (Postgres)
  ↓
JSONB Results
  ↓
quality_data_validation Table
  ↓
Dashboard Queries ← HTTP Endpoint (/results, /alerts)
```

### RPC Call Sequence (Quick Health Example)

```
Worker Init (env setup, Hyperdrive connect)
  ├─ rpc_check_staleness (2s SLA)
  │  └─ result: {"status": "pass", "issue_count": 0}
  ├─ rpc_check_architecture_gates (2s SLA) [MUST RUN FIRST]
  │  └─ result: {"status": "pass" or "HARD_FAIL"}
  └─ rpc_check_duplicates (1s SLA)
     └─ result: {"status": "warning", "issue_count": 5}
```

## References

- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Hyperdrive Setup Guide](https://developers.cloudflare.com/hyperdrive/)
- [Data Quality Validation Plan](../../docs/DATA_QUALITY_VALIDATION_WORKER_PLAN.md)
- [RPC Function Specifications](../../docs/DATA_QUALITY_VALIDATION_WORKER_PLAN.md#phase-0-rpc-suite--explicit-specifications-blocking)

## Support

For issues or questions:
1. Check Worker logs: `wrangler tail`
2. Verify Postgres connectivity
3. Review RPC function execution times
4. Check `quality_data_validation` table for results
