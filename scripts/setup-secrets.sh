#!/bin/bash
# Setup script for Cloudflare CI/CD secrets
# Run this script to configure all required GitHub secrets

set -e

echo "================================================"
echo "  Cloudflare CI/CD Setup - GitHub Secrets"
echo "================================================"
echo ""
echo "This script will help you set up all required secrets for automated deployment."
echo ""

cd /workspaces/DistortSignalsRepoV2

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Step 1: Cloudflare API Token${NC}"
echo "----------------------------------------"
echo "Create an API token at: https://dash.cloudflare.com/profile/api-tokens"
echo "Required permissions: Account > Workers Scripts > Edit"
echo ""
read -p "Enter your CLOUDFLARE_API_TOKEN: " -s CLOUDFLARE_API_TOKEN
echo ""
gh secret set CLOUDFLARE_API_TOKEN -b "$CLOUDFLARE_API_TOKEN"
echo -e "${GREEN}✓ CLOUDFLARE_API_TOKEN set${NC}"
echo ""

echo -e "${YELLOW}Step 2: Cloudflare Account ID${NC}"
echo "----------------------------------------"
echo "Your Account ID is: 513f37da8020ee565269c199ff8bb52f"
echo "Confirm this matches your Cloudflare dashboard"
echo ""
gh secret set CLOUDFLARE_ACCOUNT_ID -b "513f37da8020ee565269c199ff8bb52f"
echo -e "${GREEN}✓ CLOUDFLARE_ACCOUNT_ID set${NC}"
echo ""

echo -e "${YELLOW}Step 3: Supabase URL${NC}"
echo "----------------------------------------"
echo "Example: https://xxxxx.supabase.co"
echo ""
read -p "Enter your SUPABASE_URL: " SUPABASE_URL
gh secret set SUPABASE_URL -b "$SUPABASE_URL"
echo -e "${GREEN}✓ SUPABASE_URL set${NC}"
echo ""

echo -e "${YELLOW}Step 4: Supabase Service Role Key${NC}"
echo "----------------------------------------"
echo "Find this in Supabase Dashboard > Settings > API > service_role key"
echo ""
read -p "Enter your SUPABASE_SERVICE_ROLE_KEY: " -s SUPABASE_SERVICE_ROLE_KEY
echo ""
gh secret set SUPABASE_SERVICE_ROLE_KEY -b "$SUPABASE_SERVICE_ROLE_KEY"
echo -e "${GREEN}✓ SUPABASE_SERVICE_ROLE_KEY set${NC}"
echo ""

echo -e "${YELLOW}Step 5: Massive API Key${NC}"
echo "----------------------------------------"
echo "Your Massive.com API key for market data"
echo ""
read -p "Enter your MASSIVE_KEY: " -s MASSIVE_KEY
echo ""
gh secret set MASSIVE_KEY -b "$MASSIVE_KEY"
echo -e "${GREEN}✓ MASSIVE_KEY set${NC}"
echo ""

echo -e "${YELLOW}Step 6: Internal API Key${NC}"
echo "----------------------------------------"
echo "Generating a secure random key..."
INTERNAL_API_KEY=$(openssl rand -hex 32)
gh secret set INTERNAL_API_KEY -b "$INTERNAL_API_KEY"
echo -e "${GREEN}✓ INTERNAL_API_KEY set (generated)${NC}"
echo ""

echo "================================================"
echo -e "${GREEN}✓ All secrets configured successfully!${NC}"
echo "================================================"
echo ""
echo "Next steps:"
echo "1. Verify secrets: gh secret list"
echo "2. Deploy via Git: git push origin main"
echo "3. Or trigger manually: gh workflow run 'Deploy Tick Factory Worker'"
echo ""
echo "Monitor deployment: gh run watch"
echo "View logs: npx wrangler tail tick-factory-dev"
echo ""
