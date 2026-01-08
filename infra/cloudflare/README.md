# Cloudflare Infrastructure

Configuration for Cloudflare Workers, KV, and Durable Objects.

## Workers

### tick-factory
- **Purpose**: Market data ingestion and tick generation
- **Route**: `tick-factory.distortsignals.workers.dev`
- **Bindings**: 
  - KV: `TICK_CACHE`
  - D1: `DB`

### communication-hub
- **Purpose**: WebSocket connections and real-time communication
- **Route**: `hub.distortsignals.workers.dev`
- **Bindings**:
  - Durable Object: `ConnectionManager`
  - KV: `SESSION_STORE`

### public-api
- **Purpose**: Public REST API for signal subscriptions
- **Route**: `api.distortsignals.com`
- **Bindings**:
  - D1: `DB`
  - KV: `RATE_LIMIT`

### director-endpoints
- **Purpose**: Internal API for trade director
- **Route**: `director.distortsignals.workers.dev`
- **Bindings**:
  - D1: `DB`
  - Queue: `DIRECTIVE_QUEUE`

## KV Namespaces

- `TICK_CACHE`: Market tick cache (TTL: 5 minutes)
- `SESSION_STORE`: WebSocket session storage
- `RATE_LIMIT`: Rate limiting counters
- `CONFIG_STORE`: Application configuration

## D1 Databases

- `distortsignals-prod`: Main production database
- `distortsignals-staging`: Staging database

## Deployment

```bash
# Deploy all workers
wrangler deploy

# Deploy specific worker
cd apps/typescript/tick-factory
wrangler deploy --env production
```

## Monitoring

- Worker logs: `wrangler tail`
- Analytics: Cloudflare Dashboard
- Alerts: Configured via Cloudflare Workers Analytics
