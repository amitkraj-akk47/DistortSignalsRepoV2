# Cloudflare Authentication & CI/CD Setup Guide

## Overview

This guide will help you set up Cloudflare authentication and automated CI/CD deployment for both tick-factory and aggregator workers.

---

## Step 1: Get Your Cloudflare API Token

### Option A: Create New API Token (Recommended)

1. **Go to Cloudflare Dashboard:**
   - Visit: https://dash.cloudflare.com/profile/api-tokens

2. **Create Custom Token:**
   - Click "Create Token"
   - Click "Create Custom Token"

3. **Configure Permissions:**
   ```
   Token Name: GitHub Actions - Workers Deploy
   
   Permissions:
   - Account | Workers Scripts | Edit
   - Account | Workers KV Storage | Edit (if using KV)
   - Account | Account Settings | Read
   
   Account Resources:
   - Include | Your Account Name (or All accounts)
   
   Zone Resources:
   - Not needed for Workers
   
   Client IP Address Filtering:
   - Leave blank (GitHub Actions IPs vary)
   
   TTL:
   - Leave as default or set expiry date
   ```

4. **Create and Save Token:**
   - Click "Continue to summary"
   - Click "Create Token"
   - **IMPORTANT:** Copy the token immediately - you won't see it again!

### Option B: Use Existing API Token

If you already have a token with Workers permissions, you can use that.

---

## Step 2: Get Your Cloudflare Account ID

1. **Go to Cloudflare Dashboard:**
   - Visit: https://dash.cloudflare.com/

2. **Select Workers & Pages:**
   - Click "Workers & Pages" in left sidebar

3. **Find Account ID:**
   - Your Account ID is shown on the right side
   - Or check the URL: `https://dash.cloudflare.com/<ACCOUNT_ID>/workers-and-pages`
   - Your Account ID: **513f37da8020ee565269c199ff8bb52f** (already in wrangler.toml)

---

## Step 3: Configure GitHub Repository Secrets

You need to add the following secrets to your GitHub repository:

### Required Secrets:

| Secret Name | Description | Example |
|------------|-------------|---------|
| `CLOUDFLARE_API_TOKEN` | API token from Step 1 | `abc123...` |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID from Step 2 | `513f37da8020ee565269c199ff8bb52f` |
| `SUPABASE_URL` | Your Supabase project URL | `https://xxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key from Supabase | `eyJhbG...` |
| `MASSIVE_KEY` | Massive API key (tick-factory only) | Your API key |
| `INTERNAL_API_KEY` | Internal API key for security | Generate a secure key |

### How to Add Secrets to GitHub:

#### Method 1: Using GitHub CLI (Fastest)

```bash
cd /workspaces/DistortSignalsRepoV2

# Set Cloudflare secrets
gh secret set CLOUDFLARE_API_TOKEN
# Paste your token when prompted

gh secret set CLOUDFLARE_ACCOUNT_ID -b "513f37da8020ee565269c199ff8bb52f"

# Set Supabase secrets
gh secret set SUPABASE_URL
# Paste your Supabase URL when prompted

gh secret set SUPABASE_SERVICE_ROLE_KEY
# Paste your service role key when prompted

# Set Massive API key
gh secret set MASSIVE_KEY
# Paste your Massive API key when prompted

# Set Internal API key (generate a secure random key)
gh secret set INTERNAL_API_KEY -b "$(openssl rand -hex 32)"
```

#### Method 2: Using GitHub Web UI

1. **Go to Repository Settings:**
   - Navigate to: https://github.com/amitkraj-akk47/DistortSignalsRepoV2/settings/secrets/actions

2. **Add Each Secret:**
   - Click "New repository secret"
   - Enter the secret name (e.g., `CLOUDFLARE_API_TOKEN`)
   - Enter the secret value
   - Click "Add secret"
   - Repeat for all secrets above

---

## Step 4: Verify Secrets Are Set

```bash
# List all secrets (won't show values, just names)
gh secret list
```

You should see:
- ✓ CLOUDFLARE_API_TOKEN
- ✓ CLOUDFLARE_ACCOUNT_ID
- ✓ SUPABASE_URL
- ✓ SUPABASE_SERVICE_ROLE_KEY
- ✓ MASSIVE_KEY
- ✓ INTERNAL_API_KEY

---

## Step 5: Test Local Deployment (Optional)

Before using CI/CD, test local deployment with your token:

```bash
# Set environment variables for local testing
export CLOUDFLARE_API_TOKEN="your-token-here"
export CLOUDFLARE_ACCOUNT_ID="513f37da8020ee565269c199ff8bb52f"

# Test tick-factory deployment
cd apps/typescript/tick-factory
npx wrangler deploy --env dev

# Test aggregator deployment
cd ../aggregator
npx wrangler deploy --env dev
```

---

## Step 6: Configure Worker Secrets in Cloudflare

The GitHub Actions workflow will automatically set worker secrets, but you can also do it manually:

```bash
cd /workspaces/DistortSignalsRepoV2/apps/typescript/tick-factory

# Set secrets for tick-factory-dev
echo "YOUR_MASSIVE_KEY" | npx wrangler secret put MASSIVE_KEY --env dev
echo "YOUR_SUPABASE_URL" | npx wrangler secret put SUPABASE_URL --env dev
echo "YOUR_SERVICE_ROLE_KEY" | npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env dev
echo "YOUR_INTERNAL_API_KEY" | npx wrangler secret put INTERNAL_API_KEY --env dev

cd ../aggregator

# Set secrets for aggregator-dev
echo "YOUR_SUPABASE_URL" | npx wrangler secret put SUPABASE_URL --env dev
echo "YOUR_SERVICE_ROLE_KEY" | npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env dev
```

---

## Step 7: Trigger First Deployment

### Option A: Push to Main (Automatic)

```bash
cd /workspaces/DistortSignalsRepoV2

# Commit and push your changes
git add .
git commit -m "feat: Add DXY derivation and aggregator setup"
git push origin main
```

The workflows will automatically trigger and deploy:
- ✅ **Tick-factory** (with DXY patch) → tick-factory-dev
- ✅ **Aggregator** → aggregator-dev

### Option B: Manual Trigger via GitHub UI

1. Go to: https://github.com/amitkraj-akk47/DistortSignalsRepoV2/actions
2. Select "Deploy Tick Factory Worker" or "Deploy Aggregator Worker"
3. Click "Run workflow"
4. Select branch: `main`
5. Click "Run workflow"

### Option C: Manual Trigger via GitHub CLI

```bash
# Trigger tick-factory deployment
gh workflow run "Deploy Tick Factory Worker"

# Trigger aggregator deployment
gh workflow run "Deploy Aggregator Worker"
```

---

## Step 8: Monitor Deployment

### Watch Deployment Progress

```bash
# Monitor workflows
gh run watch
```

Or visit: https://github.com/amitkraj-akk47/DistortSignalsRepoV2/actions

### Check Deployment Logs

In GitHub Actions, you'll see:
- ✅ Dependencies installed
- ✅ Worker deployed to Cloudflare
- ✅ Secrets configured
- ✅ Deployment summary

---

## Step 9: Verify Workers Are Running

### Check in Cloudflare Dashboard

1. Visit: https://dash.cloudflare.com/513f37da8020ee565269c199ff8bb52f/workers-and-pages
2. You should see:
   - ✓ **tick-factory-dev** (with cron triggers: */10 * * * *)
   - ✓ **aggregator-dev** (with cron triggers: 1-59/5 * * * *)

### Tail Live Logs

```bash
# Watch tick-factory logs
npx wrangler tail tick-factory-dev

# Watch aggregator logs
npx wrangler tail aggregator-dev
```

---

## Troubleshooting

### Issue: "Authentication error [code: 10000]"

**Solution:** 
- Verify CLOUDFLARE_API_TOKEN is correct
- Check token has Workers Scripts Edit permission
- Ensure token hasn't expired

### Issue: "Account ID is incorrect"

**Solution:**
- Verify CLOUDFLARE_ACCOUNT_ID matches your account
- Check: https://dash.cloudflare.com/

### Issue: Secrets not updating

**Solution:**
The GitHub Actions workflow sets secrets on every deployment. If secrets aren't updating:
1. Manually set them via Cloudflare dashboard or `wrangler secret put`
2. Or comment out the "Configure Worker Secrets" step in workflow

### Issue: Worker deployed but not running

**Solution:**
- Check cron triggers in Cloudflare dashboard
- Verify worker has required secrets (SUPABASE_URL, etc.)
- Check worker logs for errors

---

## CI/CD Workflow Details

### Tick-Factory Workflow

**File:** `.github/workflows/deploy-tick-factory.yml`

**Triggers:**
- Push to `main` branch when files change in:
  - `apps/typescript/tick-factory/**`
  - `packages/ts-core/**`
  - `packages/ts-contracts/**`
  - `packages/ts-supabase/**`
  - `.github/workflows/deploy-tick-factory.yml`
- Manual trigger via `workflow_dispatch`

**Deploys:** tick-factory-dev

### Aggregator Workflow

**File:** `.github/workflows/deploy-aggregator.yml`

**Triggers:**
- Push to `main` branch when files change in:
  - `apps/typescript/aggregator/**`
  - `.github/workflows/deploy-aggregator.yml`
- Manual trigger via `workflow_dispatch`

**Deploys:** aggregator-dev

---

## Security Best Practices

1. **Rotate API Tokens Regularly**
   - Set expiry dates on tokens
   - Rotate every 90 days

2. **Use Scoped Tokens**
   - Create separate tokens for different workflows
   - Limit permissions to minimum required

3. **Monitor API Token Usage**
   - Check Cloudflare audit logs
   - Review GitHub Actions logs

4. **Protect Secrets**
   - Never commit secrets to repository
   - Use environment-specific secrets
   - Rotate compromised secrets immediately

---

## Next Steps After Deployment

1. **Monitor First Run:**
   ```bash
   npx wrangler tail tick-factory-dev
   npx wrangler tail aggregator-dev
   ```

2. **Verify Data Flow:**
   ```sql
   -- Check tick-factory ingested FX data
   SELECT canonical_symbol, COUNT(*) as bars, MAX(ts_utc)
   FROM data_bars
   WHERE timeframe = '1m' AND canonical_symbol IN ('EURUSD','USDJPY','GBPUSD','USDCAD','USDSEK','USDCHF')
   GROUP BY canonical_symbol;
   
   -- Check DXY 1m was derived
   SELECT COUNT(*), MAX(ts_utc)
   FROM derived_data_bars
   WHERE canonical_symbol='DXY' AND timeframe='1m' AND deleted_at IS NULL;
   
   -- Check aggregator created 5m and 1h bars
   SELECT canonical_symbol, timeframe, COUNT(*) as bars
   FROM derived_data_bars
   WHERE source='agg' AND deleted_at IS NULL
   GROUP BY canonical_symbol, timeframe;
   ```

3. **Check Run Logs:**
   ```sql
   SELECT * FROM ops_runlog ORDER BY started_at DESC LIMIT 10;
   ```

---

## Quick Reference Commands

```bash
# Set all secrets at once (interactive)
cd /workspaces/DistortSignalsRepoV2

gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_ACCOUNT_ID -b "513f37da8020ee565269c199ff8bb52f"
gh secret set SUPABASE_URL
gh secret set SUPABASE_SERVICE_ROLE_KEY
gh secret set MASSIVE_KEY
gh secret set INTERNAL_API_KEY -b "$(openssl rand -hex 32)"

# Deploy via Git push
git add .
git commit -m "feat: Deploy tick-factory and aggregator"
git push origin main

# Watch deployment
gh run watch

# Tail logs
npx wrangler tail tick-factory-dev
npx wrangler tail aggregator-dev
```

---

## Support Resources

- **Cloudflare Workers Docs:** https://developers.cloudflare.com/workers/
- **Wrangler CLI Docs:** https://developers.cloudflare.com/workers/wrangler/
- **GitHub Actions Docs:** https://docs.github.com/en/actions
- **GitHub CLI Docs:** https://cli.github.com/manual/
