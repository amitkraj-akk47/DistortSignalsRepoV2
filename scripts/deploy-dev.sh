#!/bin/bash
# Quick deployment script - deploys both workers to DEV

set -e

echo "🚀 Deploying DistortSignals Workers to DEV..."
echo ""

cd /workspaces/DistortSignalsRepoV2

# Check if we're on main branch
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
  echo "⚠️  Warning: Not on main branch (currently on: $BRANCH)"
  read -p "Continue anyway? (y/n) " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
  echo "📝 You have uncommitted changes"
  read -p "Commit and push now? (y/n) " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Commit message:"
    read -p "> " COMMIT_MSG
    git add .
    git commit -m "$COMMIT_MSG"
  fi
fi

# Push to trigger CI/CD
echo "📤 Pushing to GitHub..."
git push origin main

echo ""
echo "✅ Pushed to main - CI/CD will automatically deploy:"
echo "   • tick-factory-dev (with DXY integration)"
echo "   • aggregator-dev"
echo ""
echo "📊 Monitor deployment:"
echo "   gh run watch"
echo ""
echo "📝 View logs:"
echo "   npx wrangler tail tick-factory-dev"
echo "   npx wrangler tail aggregator-dev"
echo ""
