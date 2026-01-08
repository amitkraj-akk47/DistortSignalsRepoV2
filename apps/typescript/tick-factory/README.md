# Tick Factory Worker

**Market Data Ingestion Worker** - Production-ready Cloudflare Worker for ingesting market data from Massive API.

## Features

- ✅ Automated market data ingestion from Massive API
- ✅ Class A (1-minute) and Class B (5-minute) asset support
- ✅ Structured logging with configurable log levels
- ✅ Distributed locking for concurrent execution safety
- ✅ Automatic retry with exponential backoff
- ✅ Per-asset timing metrics and statistics
- ✅ Auto-disable assets after consecutive failures
- ✅ CI/CD deployment via GitHub Actions

## Purpose

- Ingests real-time OHLCV market data from Massive API
- Stores data in Supabase for downstream consumption
- Runs every 3 minutes via Cloudflare Cron triggers
- Supports multiple environments (dev, test, stage, prod)

## Environment Variables

### Required Secrets (set via Cloudflare)
```env
MASSIVE_KEY=your-massive-api-key
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
INTERNAL_API_KEY=your-internal-api-key
```

### Configuration Variables (set in wrangler.toml)
```env
JOB_NAME=tick_factory_ingest_massive_ab
MAX_ASSETS_PER_RUN=200
REQUEST_TIMEOUT_MS=30000
LOG_LEVEL=INFO
PROGRESS_INTERVAL=10
```

## Development

```bash
# Install dependencies
pnpm install

# Run locally
pnpm dev

# Deploy to dev
pnpm wrangler deploy --env dev

# Watch live logs
pnpm wrangler tail --env dev
```

## Deployment

Automated via GitHub Actions on push to `main` branch.

Manual deployment:
```bash
pnpm wrangler deploy --env dev
```

## Monitoring

View logs in Cloudflare Dashboard:
https://dash.cloudflare.com/513f37da8020ee565269c199ff8bb52f/workers-and-pages

Or tail logs in real-time:
```bash
pnpm wrangler tail --env dev
```

## Architecture

This worker ingests market data every 3 minutes via Cloudflare Cron triggers and stores it in Supabase for downstream consumption by trading systems.
