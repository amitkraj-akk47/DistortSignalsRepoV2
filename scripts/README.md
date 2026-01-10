# Deployment Scripts

Quick scripts for managing DistortSignals deployments.

## Setup Scripts

### `setup-secrets.sh`
Configure GitHub secrets for CI/CD deployment.

```bash
./scripts/setup-secrets.sh
```

This will prompt you for:
- Cloudflare API Token
- Supabase URL
- Supabase Service Role Key
- Massive API Key
- Auto-generates Internal API Key

## Deployment Scripts

### `deploy-dev.sh`
Deploy both workers to DEV environment via Git push.

```bash
./scripts/deploy-dev.sh
```

This will:
1. Check current branch
2. Check for uncommitted changes
3. Optionally commit and push
4. Trigger CI/CD deployment

## Manual Deployment Commands

### Deploy Tick-Factory
```bash
cd apps/typescript/tick-factory
npx wrangler deploy --env dev
```

### Deploy Aggregator
```bash
cd apps/typescript/aggregator
npx wrangler deploy --env dev
```

### Tail Logs
```bash
npx wrangler tail tick-factory-dev
npx wrangler tail aggregator-dev
```

## CI/CD Workflows

Automated deployment workflows are configured in `.github/workflows/`:

- `deploy-tick-factory.yml` - Deploys on changes to tick-factory
- `deploy-aggregator.yml` - Deploys on changes to aggregator

Both trigger on:
- Push to `main` branch (when relevant files change)
- Manual trigger via GitHub Actions UI

## More Information

See: [`docs/CLOUDFLARE_CI_CD_SETUP.md`](../docs/CLOUDFLARE_CI_CD_SETUP.md)
