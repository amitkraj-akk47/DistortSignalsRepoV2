# Pause/Resume Data Fetching Feature

## Overview

The pause/resume feature allows you to temporarily stop API data fetching for specific assets without disabling them completely. When an asset is paused, the worker skips the API call to Massive but maintains all state management.

## Key Features

- **Granular Control**: Pause individual assets without affecting others
- **Non-Destructive**: State records remain intact and updated
- **Instant**: Takes effect on the next worker run (every 5 minutes)
- **Resumable**: Simply set the flag back to resume fetching

## How It Works

1. **Database Column**: `data_ingest_state.pause_fetch` (boolean, default: false)
2. **Worker Check**: Before fetching from Massive API, worker checks the `pause_fetch` flag
3. **When TRUE**: Worker skips API fetch and continues to next asset
4. **When FALSE**: Worker proceeds with normal data fetching

## Usage

### Using the Helper Script

**Pause one or more assets:**
```bash
python scripts/pause_resume_asset.py pause AUDNZD BTC XAGUSD
```

**Resume fetching:**
```bash
python scripts/pause_resume_asset.py resume AUDNZD BTC XAGUSD
```

### Using SQL Directly

**Pause an asset:**
```sql
UPDATE data_ingest_state 
SET pause_fetch = true,
    notes = 'Data fetching PAUSED by user on ' || NOW()::text,
    updated_at = NOW()
WHERE canonical_symbol = 'AUDNZD';
```

**Resume an asset:**
```sql
UPDATE data_ingest_state 
SET pause_fetch = false,
    notes = 'Data fetching RESUMED by user on ' || NOW()::text,
    updated_at = NOW()
WHERE canonical_symbol = 'AUDNZD';
```

**Check pause status:**
```sql
SELECT canonical_symbol, timeframe, status, pause_fetch, notes, updated_at
FROM data_ingest_state
WHERE pause_fetch = true
ORDER BY canonical_symbol, timeframe;
```

## Use Cases

1. **Cost Management**: Temporarily pause expensive data sources
2. **Maintenance**: Pause while fixing data quality issues
3. **Testing**: Pause production fetching during development
4. **Rate Limiting**: Pause assets when hitting API limits
5. **Selective Backfill**: Pause ongoing fetching to focus on backfills

## Workflow Example

### Scenario: Pause BTC while investigating data issues

```bash
# 1. Pause BTC fetching
python scripts/pause_resume_asset.py pause BTC

# 2. Worker logs will show on next run (every 5 min):
#    [PAUSED] Asset BTC (1m) has pause_fetch=true, skipping API fetch

# 3. Investigate and fix data issues
# ... perform analysis, cleanup, etc ...

# 4. Resume BTC fetching
python scripts/pause_resume_asset.py resume BTC

# 5. Worker resumes normal fetching on next run
```

## Important Notes

- **Worker Skip Only**: Pausing affects API fetching but doesn't stop state management
- **All Timeframes**: Pause applies to all timeframes for that asset
- **No Data Loss**: Historical data remains intact
- **Quick Resume**: No warmup needed when resuming
- **Logged**: Worker logs show when assets are skipped due to pause flag

## Migration

The pause feature was added in migration `009_add_pause_fetch_flag.sql`:

```sql
ALTER TABLE data_ingest_state 
ADD COLUMN IF NOT EXISTS pause_fetch BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_data_ingest_state_pause_fetch 
ON data_ingest_state(pause_fetch) 
WHERE pause_fetch = true;
```

## Worker Code Changes

The worker checks the pause flag at STEP 1, before calling `ingest_asset_start`:

```typescript
// Check pause_fetch flag
const pauseCheck = await supa.get<Array<{ pause_fetch: boolean }>>(
  `/rest/v1/data_ingest_state?canonical_symbol=eq.${canonical}&timeframe=eq.${tf}&select=pause_fetch`
);

if (pauseCheck.length > 0 && pauseCheck[0].pause_fetch === true) {
  log.info("PAUSED", `Asset ${canonical} (${tf}) has pause_fetch=true, skipping API fetch`);
  bumpSkip("paused_by_flag");
  continue; // Skip to next asset
}
```

## Monitoring

**View all paused assets:**
```sql
SELECT 
  canonical_symbol,
  timeframe,
  status,
  pause_fetch,
  notes,
  updated_at,
  last_bar_ts_utc
FROM data_ingest_state
WHERE pause_fetch = true
ORDER BY updated_at DESC;
```

**Count paused assets:**
```sql
SELECT COUNT(DISTINCT canonical_symbol) as paused_assets
FROM data_ingest_state
WHERE pause_fetch = true;
```

## Troubleshooting

### Asset Not Pausing
- Check database connection
- Verify `pause_fetch` column exists: `\d data_ingest_state`
- Run migration if needed: `009_add_pause_fetch_flag.sql`
- Check worker logs for "PAUSE_CHECK_FAILED" messages

### Asset Not Resuming
- Verify `pause_fetch = false` in database
- Wait for next worker run (every 5 minutes)
- Check worker logs for asset processing

### Performance
- Index exists on `pause_fetch` for efficient queries
- Pause check adds 1 database query per asset (minimal overhead)
- Check fails gracefully - won't block worker execution
