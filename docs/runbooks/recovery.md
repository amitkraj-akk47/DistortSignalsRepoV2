# DistortSignals Recovery Runbook

## Overview

This runbook provides step-by-step recovery procedures for common failure scenarios in the DistortSignals trading system.

## Emergency Contacts

- **On-Call Engineer**: [Your contact info]
- **Database Admin**: [DBA contact]
- **Broker Support**: [MT5 broker support]

## Common Failure Scenarios

### 1. Signal Generator Crash

**Symptoms**: No new signals in `signal_outbox` table for > 5 minutes

**Recovery Steps**:
1. Check logs: `tail -f logs/signal-generator.log`
2. Verify database connectivity: `psql -h [host] -U [user] -d distortsignals -c "SELECT 1"`
3. Restart service: `systemctl restart signal-generator` or container equivalent
4. Verify recovery: Check for new entries in `signal_outbox`

**Prevention**: Implement health check endpoint, set up monitoring alerts

### 2. Trade Director Not Processing Directives

**Symptoms**: Stale entries in `trade_directives` table with `status = 'pending'`

**Recovery Steps**:
1. Check circuit breaker status in logs
2. Verify MT5 connection: Check `execution_officer` polling logs
3. Reset circuit breaker: `curl -X POST http://trade-director/admin/reset-circuit`
4. Manual intervention if needed: Update directive status via SQL

**Rollback Plan**: Mark pending directives as `'cancelled'` if unrecoverable

### 3. Database Connection Pool Exhaustion

**Symptoms**: Connection timeout errors, 500 responses from APIs

**Recovery Steps**:
1. Check active connections: 
   ```sql
   SELECT count(*), state FROM pg_stat_activity GROUP BY state;
   ```
2. Kill long-running queries if safe:
   ```sql
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity 
   WHERE state = 'idle in transaction' AND query_start < now() - interval '10 minutes';
   ```
3. Increase pool size temporarily in config
4. Restart affected services

### 4. Cloudflare Worker Rate Limiting

**Symptoms**: 429 errors from `tick-factory` or other workers

**Recovery Steps**:
1. Check Cloudflare dashboard for rate limit metrics
2. Implement exponential backoff in calling service
3. Scale up Cloudflare plan if consistently hitting limits
4. Consider batching requests

### 5. MT5 EA Disconnected

**Symptoms**: No execution confirmations, directive timeouts

**Recovery Steps**:
1. Check MT5 terminal connectivity
2. Verify EA is running: Check "Experts" tab in MT5
3. Restart EA: Disable and re-enable in terminal
4. Check broker server status
5. Failover to backup EA instance if configured

**Prevention**: Implement heartbeat mechanism, dual EA setup

## Monitoring Queries

### Check System Health
```sql
-- Recent signals
SELECT COUNT(*) FROM signal_outbox WHERE created_at > NOW() - INTERVAL '5 minutes';

-- Pending directives
SELECT COUNT(*) FROM trade_directives WHERE status = 'pending' AND created_at < NOW() - INTERVAL '10 minutes';

-- Failed executions
SELECT * FROM execution_events WHERE status = 'failed' AND created_at > NOW() - INTERVAL '1 hour';
```

## Escalation Procedure

1. **Level 1** (0-15 min): Automated recovery, check runbook
2. **Level 2** (15-30 min): Engage on-call engineer
3. **Level 3** (30+ min): Halt trading, notify stakeholders

## Post-Incident

1. Write incident report
2. Update runbook with lessons learned
3. Add ADR if architectural changes needed
4. Schedule blameless postmortem

---

**Last Updated**: 2026-01-03  
**Owner**: SRE Team
