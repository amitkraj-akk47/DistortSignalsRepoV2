# Data Verification Script

Comprehensive data verification tool for validating the DistortSignals ingestion and aggregation pipeline with enhanced validation checks.

## Overview

This script performs two types of verification with extensive quality checks:

### Phase A: Active Asset Verification
Checks data quality for all active assets over the most recent time period (default: 7 days):
- **Freshness with Thresholds**: Latest 1m bar timestamp with warning (>5m) and critical (>15m) staleness alerts
- **Duplicates**: Duplicate rows in `data_bars` (1m) and `derived_data_bars` (1m/5m/1h)
- **Alignment**: Timestamp alignment for 5m and 1h bars
- **Aggregation Coverage**: Ensures each 5m bar has exactly 5 underlying 1m bars (strict validation)
- **Timestamp Monotonicity**: Detects out-of-order data
- **Future Timestamps**: Flags timestamps beyond current time
- **Enhanced OHLC Integrity**: High >= Low, Open/Close within [Low, High], spread validation, zero-range detection
- **Volume Integrity**: Negative, null, or zero volume detection (if volume column exists)
- **Price Continuity**: Detects large price jumps (>10%) between consecutive bars
- **Cross-Timeframe Consistency**: Validates 5m bars match aggregated 1m data

### Phase B: Historical Data Verification
Validates 3-year historical data integrity:
- **OHLC Integrity**: Checks for null values, non-positive values, and logical inconsistencies
- **Enhanced OHLC**: Additional checks for High >= Low, spread validation, zero-range bars
- **Volume Integrity**: Historical volume validation
- **Row Counts**: Bar counts per asset over the historical period
- **Gap Density**: Number and size of gaps in historical data
- **DXY Validation**: 
  - Counts for DXY 1m/5m/1h bars
  - Component dependency (ensures EURUSD, USDJPY, GBPUSD, USDCAD, USDSEK, USDCHF are available)
  - Alignment checks for DXY derived timeframes

## Key Features

✅ **Date-stamped outputs**: All reports include timestamp (YYYYMMDD_HHMMSS) for tracking  
✅ **Configurable thresholds**: Staleness, price jumps, and table names via environment variables  
✅ **Strict aggregation validation**: Requires exactly 5 bars for 5m aggregation  
✅ **Market-aware**: Separate warning/critical staleness thresholds  
✅ **Production-ready**: Comprehensive error handling and detailed diagnostics

## Setup

### 1. Install Dependencies

```bash
cd /workspaces/DistortSignalsRepoV2/scripts
pip install -r requirements-verification.txt
```

### 2. Configure Database Connection

Create a `.env` file in the scripts directory:

```bash
cp .env.example .env
```

Edit `.env` with your Supabase credentials:

**Option 1: Connection String (Recommended)**
```bash
PG_DSN="postgresql://postgres.YOUR_PROJECT_REF:YOUR_PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require"
```

**Option 2: Discrete Parameters**
```bash
PGHOST=aws-0-us-east-1.pooler.supabase.com
PGPORT=5432
PGDATABASE=postgres
PGUSER=postgres.YOUR_PROJECT_REF
PGPASSWORD=YOUR_PASSWORD
PGSSLMODE=require
```

### 3. Optional Configuration

Customize verification parameters in `.env`:
```bash
OUTPUT_DIR="reports/datavalidation"  # Output directory (default)
ACTIVE_DAYS=7                         # Days for Phase A
HIST_YEARS=3                          # Years for Phase B

# Staleness thresholds (minutes)
STALENESS_WARNING_MINUTES=5           # Warning threshold
STALENESS_CRITICAL_MINUTES=15         # Critical threshold

# Override table names if needed
REGISTRY_TABLE=core_asset_registry_all
DATA_BARS_TABLE=data_bars
DERIVED_BARS_TABLE=derived_data_bars
```

## Usage

### Run Phase A (Active Assets)
```bash
python verify_data.py --phase A
```

### Run Phase B (Historical Data)
```bash
python verify_data.py --phase B
```

### Run Both Phases
```bash
python verify_data.py --phase ALL
```

### Custom Options
```bash
python verify_data.py --phase ALL \
  --output-dir ./my-reports \
  --active-days 14 \
  --hist-years 5
```

## Output

The script generates date-stamped files in `reports/datavalidation/`:

1. **CSV and JSON files** for each check (format: `YYYYMMDD_HHMMSS_<check_name>`):
   
   **Phase A (Active Assets):**
   - `20260112_143022_A_freshness_1m.csv` / `.json`
   - `20260112_143022_A_duplicates_data_bars_1m.csv` / `.json`
   - `20260112_143022_A_duplicates_derived_bars_1m_5m_1h.csv` / `.json`
   - `20260112_143022_A_alignment_derived_5m.csv` / `.json`
   - `20260112_143022_A_alignment_derived_1h.csv` / `.json`
   - `20260112_143022_A_agg_coverage_bad_5m_bars.csv` / `.json`
   - `20260112_143022_A_timestamp_monotonicity.csv` / `.json` (NEW)
   - `20260112_143022_A_future_timestamps.csv` / `.json` (NEW)
   - `20260112_143022_A_enhanced_ohlc_integrity.csv` / `.json` (NEW)
   - `20260112_143022_A_volume_integrity.csv` / `.json` (NEW - if volume exists)
   - `20260112_143022_A_price_continuity.csv` / `.json` (NEW)
   - `20260112_143022_A_cross_timeframe_consistency.csv` / `.json` (NEW)
   
   **Phase B (Historical):**
   - `20260112_143022_B_integrity_data_bars_1m.csv` / `.json`
   - `20260112_143022_B_enhanced_ohlc_integrity.csv` / `.json` (NEW)
   - `20260112_143022_B_volume_integrity.csv` / `.json` (NEW)
   - `20260112_143022_B_counts_data_bars_1m.csv` / `.json`
   - `20260112_143022_B_gap_density_data_bars_1m.csv` / `.json`
   - `20260112_143022_B_counts_DXY_derived_*.csv` / `.json`
   - `20260112_143022_B_DXY_component_dependency.csv` / `.json`
   - `20260112_143022_B_DXY_alignment_*.csv` / `.json`

2. **Console output** with summaries and top issues

3. **Timestamped summary.json** (e.g., `20260112_143022_summary.json`) with:
   - Problem flags
   - Run metadata
   - Configuration settings
   - Output directory paths

## Interpreting Results

### Exit Codes
- **0**: All checks passed
- **1**: Issues detected (check summary.json and individual reports)

### Problem Flags

The timestamped `summary.json` file contains boolean flags:

**Phase A (NEW Enhanced Flags):**
- `duplicates_data_bars_1m`: Duplicate rows in raw 1m data
- `duplicates_derived`: Duplicate rows in aggregated data
- `misaligned_5m`: 5m bars not aligned to :00, :05, :10, etc.
- `misaligned_1h`: 1h bars not aligned to :00
- `bad_5m_coverage`: 5m bars with <5 underlying 1m bars (stricter than before)
- `non_monotonic_timestamps`: ⚠️ Out-of-order timestamps detected
- `future_timestamps`: ⚠️ Timestamps beyond current time
- `enhanced_ohlc_issues`: ⚠️ High < Low, Open/Close outside [Low, High], excessive spreads
- `volume_issues`: Negative or null volume values
- `large_price_jumps`: Price jumps >10% between consecutive bars
- `cross_timeframe_mismatch`: ⚠️ 5m bars don't match aggregated 1m data
- `staleness_warning`: Assets stale >5 minutes
- `staleness_critical`: ⚠️ Assets stale >15 minutes

**Phase B:**
- `integrity_issues_1m`: Basic OHLC validation failures
- `enhanced_ohlc_issues`: Advanced OHLC integrity issues
- `volume_issues`: Historical volume problems
- `dxy_component_dependency_fail`: Missing DXY component data
- `dxy_missing_5m_or_1h`: DXY aggregated timeframes not found
- `dxy_misaligned_5m`: DXY 5m alignment issues
- `dxy_misaligned_1h`: DXY 1h alignment issues

### Understanding Gaps

Market data naturally has gaps during:
- Weekends
- Holidays
- Market closures
- Low liquidity periods

High gap counts may be expected for 24/5 markets like FX. Review `max_gap` to identify abnormally large gaps.

## Database Schema Requirements

The script expects:

**Tables:**
- `core_asset_registry_all` - Asset registry with `is_active` and `canonical_symbol`
- `data_bars` - Raw OHLC data with columns: `canonical_symbol`, `timeframe`, `ts_utc`, `open`, `high`, `low`, `close`
- `derived_data_bars` - Aggregated data (same schema as `data_bars`)

**Asset symbols:**
- DXY components: EURUSD, USDJPY, GBPUSD, USDCAD, USDSEK, USDCHF

If your schema differs, edit the `Config` class in `verify_data.py`.

## Troubleshooting

### Connection Issues
```
ERROR: Failed to connect to database
```
- Verify `.env` credentials
- Check network connectivity
- Ensure Supabase project is running
- Try using the connection pooler URL

### Missing Dependencies
```
ERROR: Missing required dependency
```
Run: `pip install -r requirements-verification.txt`

### Query Timeouts
Large datasets may cause slow queries. Consider:
- Running phases separately (`--phase A` then `--phase B`)
- Reducing `--hist-years` or `--active-days`
- Using Supabase connection pooler

### Empty Results
```
Active assets query returned 0 rows
```
- Check that `core_asset_registry_all` table exists
- Verify `is_active` column has true values
- Review `Config` class table/column names

## CI/CD Integration

Add to your CI pipeline:

```yaml
- name: Verify Data Quality
  run: |
    cd scripts
    pip install -r requirements-verification.txt
    python verify_data.py --phase ALL
```

Set environment variables in your CI secrets.

## Maintenance

### Updating Table/Column Names

Edit the `Config` dataclass in `verify_data.py`:

```python
@dataclass(frozen=True)
class Config:
    registry_table: str = "your_registry_table"
    data_bars_table: str = "your_data_table"
    # ... etc
```

### Adding Custom Checks

Add new check functions following the pattern:

```python
def check_custom(conn, params) -> pd.DataFrame:
    sql = "YOUR SQL HERE"
    return qdf(conn, sql, params)
```

Call in `run_phase_a()` or `run_phase_b()` and add to reporting.

## Related Documentation

- [Aggregator Cursor Bug Fix](../docs/AGGREGATOR_CURSOR_BUG_FIX_SUMMARY.md)
- [Architecture Blueprint](../docs/architecture/DistortSignals-Blueprint-v1.md)
- [Event Ledger ADR](../docs/adr/ADR-001-event-ledger.md)

## Recent Enhancements

### V2 Improvements (January 2026)

**Enhanced Validations:**
- ✅ Timestamp monotonicity checking (detects out-of-order data)
- ✅ Future timestamp detection
- ✅ Enhanced OHLC validation (High >= Low, Open/Close range, spread checks)
- ✅ Volume integrity checks (negative, null values)
- ✅ Price continuity validation (large jump detection)
- ✅ Cross-timeframe consistency (1m vs 5m aggregation verification)
- ✅ Staleness thresholds (warning: >5m, critical: >15m)

**Output Improvements:**
- ✅ Date-stamped filenames (`YYYYMMDD_HHMMSS_<check>.csv`)
- ✅ Default output to `reports/datavalidation/`
- ✅ Enhanced summary.json with run metadata
- ✅ Configurable thresholds via environment variables

**Quality Improvements:**
- ✅ Stricter aggregation coverage (requires exactly 5 bars for 5m)
- ✅ Configurable table names via environment variables
- ✅ Better error handling and diagnostics
- ✅ Performance optimizations for large datasets

## Implementation Notes

### Critical Validations (Always Review)

1. **non_monotonic_timestamps**: Data corruption - requires immediate attention
2. **future_timestamps**: Clock skew or ingestion bugs - investigate immediately
3. **cross_timeframe_mismatch**: Aggregation bug - review aggregator logic
4. **staleness_critical**: Data pipeline stalled - check ingestion process

### Expected Findings (Normal Operations)

- **Gap density**: Expected for 24/5 markets (weekends, holidays)
- **Zero-range bars**: Normal during market closures or low liquidity
- **Staleness warnings**: May occur during scheduled maintenance

### Aggregation Coverage

The script now requires **exactly 5 underlying 1m bars** for each 5m bar (stricter than v1's "≥3"). This catches:
- Partial aggregations
- Missing source data
- Aggregator cursor issues

Adjust `min_required_1m` in code if your business logic allows partial aggregations.

## Support

For issues or questions:
1. Check the output CSV/JSON files for detailed diagnostics
2. Review database schema compatibility
3. Examine Phase A before Phase B (recent data issues may indicate ongoing problems)
