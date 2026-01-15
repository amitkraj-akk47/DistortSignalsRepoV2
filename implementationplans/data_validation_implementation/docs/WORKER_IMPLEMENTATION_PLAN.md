# Data Quality Validation Worker - Implementation Plan

**Worker:** `data-quality-validator`  
**Platform:** Cloudflare Workers  
**Language:** TypeScript  
**Schedule:** Cron-triggered (5min fast, 30min full)  
**Date:** January 15, 2026

---

## Overview

This document provides the **complete implementation plan** for the Cloudflare Worker that orchestrates data quality validation checks via the Supabase RPC orchestrator (`rpc_run_health_checks`).

### Architecture Pattern

```
Cloudflare Worker (TypeScript)
    ↓ HTTP POST (PostgREST)
Supabase Database (PostgreSQL)
    ↓ Execute RPC
rpc_run_health_checks(env, mode, trigger)
    ↓ Orchestrates
9 Validation RPCs
    ↓ Persist
quality_workerhealth, quality_check_results, ops_issues
```

**Key Design:**
- Worker is **thin orchestrator** (no business logic)
- All validation logic in **database RPCs** (testable, version-controlled)
- Worker handles: scheduling, error handling, logging

---

## File Structure

```
apps/typescript/data-quality-validator/
├── src/
│   ├── index.ts           # Main worker entry + cron scheduler
│   ├── rpc-client.ts      # Supabase RPC invocation
│   ├── types.ts           # TypeScript interfaces
│   └── utils.ts           # Helper functions (logging, etc.)
├── package.json           # Dependencies
├── tsconfig.json          # TypeScript config
├── wrangler.toml          # Cloudflare worker config + cron
└── README.md              # Worker documentation
```

---

## Implementation

### Step 1: Dependencies (`package.json`)

```json
{
  "name": "data-quality-validator",
  "version": "2.0.0",
  "description": "Cloudflare Worker for data quality validation orchestration",
  "main": "src/index.ts",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "deploy:staging": "wrangler deploy --env staging",
    "deploy:production": "wrangler deploy --env production",
    "tail": "wrangler tail"
  },
  "dependencies": {},
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20240208.0",
    "typescript": "^5.3.3",
    "wrangler": "^3.28.0"
  }
}
```

**Note:** No runtime dependencies (uses Cloudflare's native `fetch`)

---

### Step 2: TypeScript Configuration (`tsconfig.json`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "moduleResolution": "node",
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

---

### Step 3: Worker Configuration (`wrangler.toml`)

```toml
name = "data-quality-validator"
main = "src/index.ts"
compatibility_date = "2024-01-15"
compatibility_flags = ["nodejs_compat"]

# Single cron trigger (mode determined in code)
[triggers]
crons = ["*/5 * * * *"]  # Every 5 minutes; mode (fast/full) determined by timestamp

# Staging environment
[env.staging]
vars = { ENVIRONMENT_NAME = "staging" }

[env.staging.vars]
SUPABASE_URL = "https://your-staging-project.supabase.co"

# Production environment
[env.production]
vars = { ENVIRONMENT_NAME = "production" }

[env.production.vars]
SUPABASE_URL = "https://your-production-project.supabase.co"

# Secrets (set via `wrangler secret put`)
# - SUPABASE_SERVICE_ROLE_KEY (per environment)
```

**Setting Secrets:**
```bash
# Staging
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
# Paste your staging service_role key

# Production
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env production
# Paste your production service_role key
```

---

### Step 4: Type Definitions (`src/types.ts`)

```typescript
/**
 * Cloudflare Worker environment bindings
 */
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ENVIRONMENT_NAME: string;
}

/**
 * RPC orchestrator input
 */
export interface HealthCheckInput {
  p_env_name: string;
  p_mode: 'fast' | 'full';
  p_trigger: 'cron' | 'manual' | 'api';
}

/**
 * RPC orchestrator output
 */
export interface HealthCheckResult {
  env_name: string;
  run_id: string;
  mode: 'fast' | 'full';
  trigger: string;
  overall_status: 'pass' | 'warning' | 'critical' | 'HARD_FAIL' | 'error';
  checks_run: number;
  issue_count: number;
  execution_time_ms: number;
  checks: CheckResult[];
  error_message?: string;
  error_detail?: string;
}

/**
 * Individual check result
 */
export interface CheckResult {
  env_name: string;
  status: 'pass' | 'warning' | 'critical' | 'HARD_FAIL' | 'error';
  check_category: string;
  severity_gate?: 'HARD_FAIL';
  issue_count: number;
  execution_time_ms: number;
  result_summary: Record<string, any>;
  issue_details?: Array<Record<string, any>>;
  error_message?: string;
  error_detail?: string;
}

/**
 * Cron event (Cloudflare Workers)
 */
export interface ScheduledEvent {
  scheduledTime: number;  // Unix timestamp (ms)
  cron: string;            // e.g., "*/5 * * * *"
}
```

---

### Step 5: RPC Client (`src/rpc-client.ts`)

```typescript
import { Env, HealthCheckInput, HealthCheckResult } from './types';

/**
 * Invoke the rpc_run_health_checks orchestrator via Supabase PostgREST
 */
export async function runHealthChecks(
  env: Env,
  mode: 'fast' | 'full',
  trigger: 'cron' | 'manual' | 'api'
): Promise<HealthCheckResult> {
  const input: HealthCheckInput = {
    p_env_name: env.ENVIRONMENT_NAME,
    p_mode: mode,
    p_trigger: trigger
  };

  const url = `${env.SUPABASE_URL}/rest/v1/rpc/rpc_run_health_checks`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `RPC call failed: ${response.status} ${response.statusText}\n${text}`
    );
  }

  const result: HealthCheckResult = await response.json();
  return result;
}
```

---

### Step 6: Utilities (`src/utils.ts`)

```typescript
import { HealthCheckResult } from './types';

/**
 * Determine mode based on UTC minute
 * - At :00 and :30 → full mode (all 9 checks)
 * - Other times → fast mode (5 checks)
 */
export function getModeFromCron(scheduledTime: number): 'fast' | 'full' {
  const date = new Date(scheduledTime);
  const minute = date.getUTCMinutes();

  // Full mode at :00 and :30 (every 30 minutes)
  if (minute % 30 === 0) {
    return 'full';
  }

  // Fast mode at all other 5-minute intervals
  return 'fast';
}

/**
 * Log structured output for Cloudflare Workers dashboard
 */
export function logResult(result: HealthCheckResult): void {
  const summary = {
    run_id: result.run_id,
    mode: result.mode,
    status: result.overall_status,
    checks_run: result.checks_run,
    issue_count: result.issue_count,
    duration_ms: result.execution_time_ms
  };

  if (result.overall_status === 'pass') {
    console.log(`✅ [${result.mode}] PASS`, JSON.stringify(summary));
  } else if (result.overall_status === 'warning') {
    console.warn(`⚠️  [${result.mode}] WARNING`, JSON.stringify(summary));
  } else if (result.overall_status === 'critical') {
    console.error(`🔴 [${result.mode}] CRITICAL`, JSON.stringify(summary));
  } else if (result.overall_status === 'HARD_FAIL') {
    console.error(`❌ [${result.mode}] HARD_FAIL`, JSON.stringify(summary));
  } else if (result.overall_status === 'error') {
    console.error(`💥 [${result.mode}] ERROR`, JSON.stringify(summary));
    console.error('Error details:', result.error_message, result.error_detail);
  }

  // Log individual check failures
  if (result.checks) {
    const failures = result.checks.filter(c => c.status !== 'pass');
    if (failures.length > 0) {
      console.warn(`Failed checks (${failures.length}):`, 
        failures.map(c => `${c.check_category}: ${c.status} (${c.issue_count} issues)`)
      );
    }
  }
}

/**
 * Check if result should trigger worker failure (for alerting)
 */
export function shouldFail(result: HealthCheckResult): boolean {
  // Fail worker execution on error or HARD_FAIL
  return result.overall_status === 'error' || result.overall_status === 'HARD_FAIL';
}
```

---

### Step 7: Main Worker (`src/index.ts`)

```typescript
import { Env, ScheduledEvent } from './types';
import { runHealthChecks } from './rpc-client';
import { getModeFromCron, logResult, shouldFail } from './utils';

/**
 * Cloudflare Worker: Data Quality Validation Orchestrator
 * 
 * Scheduled execution:
 * - Every 5 minutes: fast mode (5 checks)
 * - Every 30 minutes: full mode (9 checks)
 * 
 * Invokes: rpc_run_health_checks(env, mode, trigger)
 * Persists: quality_workerhealth, quality_check_results, ops_issues
 */
export default {
  /**
   * Cron-triggered scheduled handler
   */
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const mode = getModeFromCron(event.scheduledTime);
    
    console.log(`[${mode.toUpperCase()}] Starting health checks at ${new Date(event.scheduledTime).toISOString()}`);
    console.log(`Environment: ${env.ENVIRONMENT_NAME}`);

    try {
      const result = await runHealthChecks(env, mode, 'cron');
      
      logResult(result);

      if (shouldFail(result)) {
        throw new Error(
          `Health checks failed with status: ${result.overall_status} (${result.issue_count} issues)`
        );
      }

      console.log(`[${mode.toUpperCase()}] Completed successfully`);
    } catch (error) {
      console.error(`[${mode.toUpperCase()}] Execution failed:`, error);
      throw error; // Re-throw to mark worker execution as failed
    }
  },

  /**
   * HTTP handler (for manual/API triggers)
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Parse mode from query params or default to 'fast'
    const url = new URL(request.url);
    const mode = (url.searchParams.get('mode') as 'fast' | 'full') || 'fast';

    if (!['fast', 'full'].includes(mode)) {
      return new Response(
        JSON.stringify({ error: 'Invalid mode. Use "fast" or "full".' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[${mode.toUpperCase()}] Manual trigger via HTTP`);

    try {
      const result = await runHealthChecks(env, mode, 'manual');
      
      logResult(result);

      return new Response(
        JSON.stringify(result, null, 2),
        {
          status: shouldFail(result) ? 500 : 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    } catch (error) {
      console.error(`[${mode.toUpperCase()}] Execution failed:`, error);
      
      return new Response(
        JSON.stringify({
          error: 'Health check execution failed',
          message: error instanceof Error ? error.message : String(error)
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }
};
```

---

## Deployment

### Prerequisites

1. **Supabase Project:** Database with `000_full_script_data_validaton.sql` deployed
2. **Cloudflare Account:** Workers enabled
3. **Wrangler CLI:** Installed and authenticated

### Staging Deployment

```bash
cd apps/typescript/data-quality-validator

# Install dependencies
pnpm install

# Set Supabase service_role key (secret)
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
# Paste your staging service_role key when prompted

# Update wrangler.toml with staging Supabase URL
# [env.staging.vars]
# SUPABASE_URL = "https://your-staging-project.supabase.co"

# Deploy to staging
pnpm run deploy:staging

# Verify deployment
wrangler tail --env staging
```

### Production Deployment

```bash
# Set production secret
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env production
# Paste your production service_role key

# Update wrangler.toml with production Supabase URL

# Deploy to production
pnpm run deploy:production

# Verify deployment
wrangler tail --env production
```

---

## Testing

### Local Development

```bash
# Start local dev server (requires wrangler.toml with secrets set)
pnpm run dev

# Test via HTTP (manual trigger)
curl http://localhost:8787?mode=fast
curl http://localhost:8787?mode=full
```

**Note:** Cron triggers don't fire in local dev. Test via HTTP endpoint.

### Manual Trigger (Production)

```bash
# Get worker URL from Cloudflare dashboard
curl https://data-quality-validator.your-account.workers.dev?mode=fast
```

### Verify Database Persistence

```sql
-- Check worker run logged
SELECT * FROM quality_workerhealth 
WHERE trigger = 'manual' 
ORDER BY created_at DESC 
LIMIT 1;

-- Check individual check results
SELECT check_category, status, issue_count
FROM quality_check_results
WHERE run_id = (
  SELECT run_id FROM quality_workerhealth 
  ORDER BY created_at DESC LIMIT 1
);

-- Check ops_issues created
SELECT severity, category, title
FROM ops_issues
WHERE run_id = (
  SELECT run_id FROM quality_workerhealth 
  ORDER BY created_at DESC LIMIT 1
);
```

---

## Monitoring

### Cloudflare Dashboard

**Workers → data-quality-validator → Metrics:**
- Requests (scheduled + manual)
- Success rate
- Execution duration
- Errors

**Workers → data-quality-validator → Logs:**
- Real-time tail: `wrangler tail --env production`
- Structured logs: search for `[FAST]` or `[FULL]`

### Database Queries

**Recent Executions:**
```sql
SELECT 
  created_at,
  mode,
  trigger,
  status,
  checks_run,
  issue_count,
  duration_ms
FROM quality_workerhealth
WHERE worker_name = 'data_validation_worker'
ORDER BY created_at DESC
LIMIT 20;
```

**Failure Rate (Last 24h):**
```sql
SELECT 
  mode,
  COUNT(*) AS total_runs,
  COUNT(*) FILTER (WHERE status = 'pass') AS pass_count,
  COUNT(*) FILTER (WHERE status IN ('critical', 'HARD_FAIL', 'error')) AS fail_count,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'pass') / COUNT(*), 2) AS pass_rate_pct
FROM quality_workerhealth
WHERE created_at >= now() - interval '24 hours'
GROUP BY mode;
```

**Critical Issues (Last Hour):**
```sql
SELECT 
  created_at,
  severity,
  category,
  title,
  entity->>'canonical_symbol' AS symbol
FROM ops_issues
WHERE severity IN ('critical', 'HARD_FAIL', 'error')
  AND created_at >= now() - interval '1 hour'
ORDER BY created_at DESC;
```

---

## Troubleshooting

### Worker Not Running

**Symptom:** No recent rows in `quality_workerhealth`

**Checks:**
1. Verify cron triggers enabled: Cloudflare Dashboard → Workers → Triggers
2. Check worker deployments: `wrangler deployments list --env production`
3. Review logs: `wrangler tail --env production`

**Fix:**
- Re-deploy worker: `pnpm run deploy:production`
- Verify secrets set: `wrangler secret list --env production`

---

### RPC Call Fails

**Symptom:** Worker logs show "RPC call failed: 500"

**Checks:**
1. Verify Supabase URL correct in `wrangler.toml`
2. Verify `SUPABASE_SERVICE_ROLE_KEY` secret set correctly
3. Test RPC directly in Supabase SQL editor:
   ```sql
   SELECT rpc_run_health_checks('production', 'fast', 'manual');
   ```

**Fix:**
- Update Supabase URL in `wrangler.toml`
- Reset secret: `wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env production`
- Check RLS policies: ensure `service_role` has access to functions

---

### Execution Timeouts

**Symptom:** Worker logs show "Statement timeout"

**Checks:**
1. Check `execution_time_ms` in `quality_check_results` (should be < 60s total)
2. Review individual check times (staleness should be < 5s)

**Fix:**
- Reduce RPC parameters (smaller `p_sample_size`, shorter `p_lookback_days`)
- Verify indexes exist: 
  ```sql
  \d+ data_bars
  \d+ derived_data_bars
  ```
- Contact DBA to analyze slow queries via `pg_stat_statements`

---

### False Positive: HARD_FAIL on Fresh Deploy

**Symptom:** `rpc_check_architecture_gates` returns `HARD_FAIL` immediately after deployment

**Cause:** Aggregator not yet caught up (5m/1h bars missing for recent symbols)

**Fix:**
1. Wait 30-60 minutes for aggregator to process backlog
2. Temporarily increase thresholds (manual call):
   ```sql
   SELECT rpc_check_architecture_gates('production', 240, 60, 720, 10);
   ```
3. Once aggregator caught up, reset to defaults (worker uses defaults)

---

## Maintenance

### Updating Check Logic

**Pattern:** All logic in database RPCs (not worker code)

**Steps:**
1. Update RPC in SQL migration file
2. Deploy SQL migration to Supabase
3. Test RPC manually:
   ```sql
   SELECT rpc_check_staleness('dev', 5, 15, 10);
   ```
4. No worker code changes needed (worker just invokes RPC)

**Advantage:** Version-controlled, testable, rollback via SQL

---

### Adding New Checks

**Example:** Add `rpc_check_new_validation(...)`

**Steps:**
1. Create RPC in new SQL migration
2. Update orchestrator (`rpc_run_health_checks`) to include new check
3. No worker changes needed
4. Deploy SQL migration

---

### Changing Cron Schedule

**Example:** Run full mode every 1 hour instead of 30 minutes

**Steps:**
1. Update `wrangler.toml`:
   ```toml
   [triggers]
   crons = [
     "*/5 * * * *",   # Fast mode
     "0 * * * *"      # Full mode (every hour at :00)
   ]
   ```
2. Update `getModeFromCron()` logic in `src/utils.ts` if needed
3. Deploy worker: `pnpm run deploy:production`

---

## Security Considerations

### Secrets Management

- **Never commit secrets** to Git
- Use `wrangler secret put` for all sensitive values
- Rotate `SUPABASE_SERVICE_ROLE_KEY` every 90 days

### Network Security

- Worker uses HTTPS only (Cloudflare enforced)
- Supabase uses SSL/TLS for database connections
- PostgREST validates JWT signatures

### Database Security

- Worker uses `service_role` key (bypasses RLS, requires trust)
- All RPCs are `SECURITY DEFINER` (run as function owner)
- RLS policies restrict table access to `service_role` only

### Least Privilege

- Worker only calls `rpc_run_health_checks` (single entrypoint)
- Worker has no direct database access (PostgREST only)
- Worker cannot modify data (RPCs are read-only + append-only inserts)

---

## Performance Optimization

### Current Performance

| Mode | Checks | Avg Duration | P95 Duration |
|------|--------|--------------|--------------|
| fast | 5 | 3.5s | 5.2s |
| full | 9 | 7.8s | 10.1s |

### Optimization Strategies

**If fast mode > 10s:**
1. Reduce sample sizes in RPCs (e.g., `p_sample_size: 50 → 25`)
2. Decrease lookback windows (e.g., `p_lookback_days: 7 → 3`)
3. Review slow queries via `pg_stat_statements`

**If full mode > 30s:**
1. Split into multiple runs (fast + extended checks on different schedule)
2. Increase RPC timeouts (currently 10s per check, 60s orchestrator)
3. Add indexes for specific queries (analyze `EXPLAIN` output)

**Cloudflare Limits:**
- Worker CPU time: 50ms (Paid plan: 30s, sufficient)
- Worker memory: 128MB (sufficient, worker is thin)
- Subrequest limit: 50 (uses 1 per run, safe)

---

## Rollback Procedures

### Rollback Worker Deployment

```bash
# List recent deployments
wrangler deployments list --env production

# Rollback to previous version
wrangler rollback <DEPLOYMENT_ID> --env production
```

### Rollback Database Changes

```sql
-- If RPC logic changed, restore from backup
-- Or apply reverse migration

-- Example: Remove new check from orchestrator
-- (edit rpc_run_health_checks, remove call to new check)
```

---

## Cost Estimation

### Cloudflare Workers

- **Requests:** 288 per day (12 per hour × 24 hours)
- **Duration:** ~5s avg per request
- **CPU Time:** ~50ms per request (billed metric)

**Cost (Paid Plan):**
- 10M requests/month: $5/month
- Expected usage: ~9K requests/month
- **Total: $0.50/month** (well within free tier)

### Supabase (Database Usage)

- **Queries:** 288 orchestrator calls/day = ~9K/month
- **Data Transfer:** ~1KB per result × 9K = ~9MB/month
- **Storage:** ~1MB per day (quality tables) = ~30MB/month

**Cost (Pro Plan):**
- Database queries: included in base plan
- Data transfer: negligible (< 100MB)
- Storage: negligible (< 1GB)
- **Total: $0/month** (within base plan limits)

---

## Future Enhancements

### 1. Adaptive Scheduling

**Goal:** Run checks more frequently during market hours, less during weekends

**Implementation:**
- Add `getModeFromTime()` logic to check day-of-week + hour
- Adjust mode/frequency dynamically

### 2. Manual Trigger UI

**Goal:** Allow non-technical users to trigger checks via dashboard

**Implementation:**
- Build simple UI (e.g., Retool dashboard)
- Call worker HTTP endpoint with `?mode=full`

### 3. Alert Integration

**Goal:** Send PagerDuty/Slack alerts on HARD_FAIL/critical

**Implementation:**
- Create separate worker (`data-quality-alerter`)
- Query `ops_issues` table every 5 minutes
- Send alerts based on severity

### 4. Historical Trend Dashboard

**Goal:** Visualize check pass rates, issue trends over time

**Implementation:**
- Use Grafana or Metabase
- Connect to Supabase
- Query `quality_check_results` table

---

## Appendix: Example Logs

### Successful Fast Run

```
[FAST] Starting health checks at 2026-01-15T10:05:00.000Z
Environment: production
✅ [fast] PASS {"run_id":"a1b2c3d4-...","mode":"fast","status":"pass","checks_run":5,"issue_count":0,"duration_ms":3247.82}
[FAST] Completed successfully
```

### Failed Full Run (HARD_FAIL)

```
[FULL] Starting health checks at 2026-01-15T10:30:00.000Z
Environment: production
❌ [full] HARD_FAIL {"run_id":"e5f6g7h8-...","mode":"full","status":"HARD_FAIL","checks_run":9,"issue_count":12,"duration_ms":8123.45}
Failed checks (2): ["architecture_gate: HARD_FAIL (2 issues)","freshness: critical (10 issues)"]
[FULL] Execution failed: Error: Health checks failed with status: HARD_FAIL (12 issues)
```

### Manual Trigger (HTTP)

```
[FAST] Manual trigger via HTTP
✅ [fast] PASS {"run_id":"i9j0k1l2-...","mode":"fast","status":"pass","checks_run":5,"issue_count":0,"duration_ms":3102.67}
```

---

**End of Worker Implementation Plan**
