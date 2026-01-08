# Infrastructure

Infrastructure as Code and deployment configurations for DistortSignals.

## Structure

### `cloudflare/`
Cloudflare Workers and D1 database configurations
- Worker routes and bindings
- KV namespace definitions
- Durable Objects
- Analytics and monitoring

### `supabase/`
Supabase project configuration
- Database migrations
- Auth policies
- Edge functions
- Storage buckets

## Deployment

### Cloudflare
```bash
# Deploy all workers
cd tools/ci && ./deploy.sh

# Deploy individual worker
cd apps/typescript/tick-factory && pnpm deploy
```

### Supabase
```bash
# Run migrations
supabase db push

# Deploy edge functions
supabase functions deploy
```

## Environment Variables

Required environment variables for deployment:

```bash
# Cloudflare
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token

# Supabase
SUPABASE_PROJECT_ID=your-project-id
SUPABASE_ACCESS_TOKEN=your-access-token
```

## Monitoring

- Cloudflare Analytics: https://dash.cloudflare.com
- Supabase Dashboard: https://app.supabase.com
- Custom metrics in `/docs/runbooks/`
