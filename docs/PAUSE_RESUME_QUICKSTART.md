# Pause/Resume Feature - Quick Reference

## Quick Commands

### Pause Assets
```bash
python scripts/pause_resume_asset.py pause SYMBOL1 SYMBOL2 ...
```

### Resume Assets
```bash
python scripts/pause_resume_asset.py resume SYMBOL1 SYMBOL2 ...
```

### Check Status
```sql
SELECT canonical_symbol, timeframe, pause_fetch, notes
FROM data_ingest_state
WHERE canonical_symbol IN ('AUDNZD', 'BTC', 'XAGUSD');
```

## Files Changed

1. **db/migrations/009_add_pause_fetch_flag.sql** - Adds `pause_fetch` column
2. **apps/typescript/tick-factory/src/ingestindex.ts** - Checks flag before API fetch
3. **scripts/pause_resume_asset.py** - Helper script for pause/resume
4. **docs/PAUSE_RESUME_FEATURE.md** - Complete documentation

## How It Works

```
Worker runs → Checks pause_fetch flag → If TRUE: Skip API fetch
                                      → If FALSE: Fetch normally
```

## Example

```bash
# Pause BTC fetching
python scripts/pause_resume_asset.py pause BTC

# Worker skips API call but maintains state
# [PAUSED] Asset BTC (1m) has pause_fetch=true, skipping API fetch

# Resume when ready
python scripts/pause_resume_asset.py resume BTC
```

## Deploy Steps

1. Apply migration: `009_add_pause_fetch_flag.sql`
2. Deploy worker code (already pushed to GitHub)
3. Use pause/resume script as needed
