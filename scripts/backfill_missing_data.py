#!/usr/bin/env python3
"""
Backfill script to fetch missing historical data from Massive API
Fills gaps between Dec 31, 2025 and current data start dates
"""

import os
import sys
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import Json, execute_values
import requests
import time

load_dotenv('scripts/.env')

# Configuration
MASSIVE_API_KEY = os.getenv('MASSIVE_KEY')
MASSIVE_API_BASE = 'https://api.polygon.io/v2/aggs/ticker'
BATCH_SIZE = 50000
MAX_RETRIES = 3
RETRY_DELAY = 2

# Asset groups and their missing date ranges
BACKFILL_GROUPS = {
    'group1_5days': {
        'symbols': ['AUDNZD', 'BTC', 'NZDUSD', 'XAGUSD'],
        'from_date': '2025-12-31',
        'to_date': '2026-01-05',
        'provider_tickers': {
            'AUDNZD': 'C:AUDNZD',
            'BTC': 'X:BTCUSD',
            'NZDUSD': 'C:NZDUSD',
            'XAGUSD': 'C:XAGUSD'
        }
    },
    'group2_8days': {
        'symbols': ['EURUSD', 'GBPUSD', 'USDCAD', 'USDCHF', 'USDJPY', 'USDSEK', 'XAUUSD'],
        'from_date': '2025-12-31',
        'to_date': '2026-01-08',
        'provider_tickers': {
            'EURUSD': 'C:EURUSD',
            'GBPUSD': 'C:GBPUSD',
            'USDCAD': 'C:USDCAD',
            'USDCHF': 'C:USDCHF',
            'USDJPY': 'C:USDJPY',
            'USDSEK': 'C:USDSEK',
            'XAUUSD': 'C:XAUUSD'
        }
    }
}

def fetch_bars_from_massive(provider_ticker, from_date, to_date, timespan='minute', multiplier=1):
    """Fetch bars from Massive API with retry logic"""
    
    # Polygon.io uses path parameters, not query params for date range
    url = f"{MASSIVE_API_BASE}/{provider_ticker}/range/{multiplier}/{timespan}/{from_date}/{to_date}"
    
    params = {
        'sort': 'asc',
        'limit': 50000,
        'apiKey': MASSIVE_API_KEY
    }
    
    for attempt in range(MAX_RETRIES):
        try:
            print(f"   Fetching {provider_ticker} ({from_date} to {to_date})...", end=' ')
            response = requests.get(url, params=params, timeout=30)
            
            if response.status_code == 200:
                data = response.json()
                results = data.get('results', [])
                print(f"✅ Got {len(results)} bars")
                return results
            elif response.status_code == 429:
                print(f"⚠️  Rate limited, waiting {RETRY_DELAY}s...")
                time.sleep(RETRY_DELAY)
            else:
                print(f"❌ HTTP {response.status_code}")
                return []
                
        except Exception as e:
            print(f"❌ Error: {str(e)}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY)
            continue
    
    return []

def insert_bars_batch(conn, canonical_symbol, provider_ticker, bars, timeframe='1m'):
    """Insert bars into data_bars table using fast batch upsert"""
    
    if not bars:
        return 0
    
    cursor = conn.cursor()
    
    try:
        # Prepare all values at once
        ingested_at = datetime.now(timezone.utc).isoformat()
        values_list = []
        
        for bar in bars:
            ts_utc = datetime.fromtimestamp(bar['t'] / 1000, tz=timezone.utc).isoformat()
            values_list.append((
                canonical_symbol,
                provider_ticker,
                timeframe,
                ts_utc,
                bar.get('o'),
                bar.get('h'),
                bar.get('l'),
                bar.get('c'),
                bar.get('v'),
                bar.get('vw'),
                bar.get('n'),
                False,
                'massive',
                ingested_at,
                Json(bar)
            ))
        
        # Use execute_values for fast batch insert (much faster than executemany)
        execute_values(cursor, '''
            INSERT INTO data_bars (
                canonical_symbol, provider_ticker, timeframe, ts_utc,
                open, high, low, close, vol, vwap, trade_count,
                is_partial, source, ingested_at, raw
            ) VALUES %s
            ON CONFLICT (canonical_symbol, timeframe, ts_utc) DO NOTHING
        ''', values_list)
        
        inserted = cursor.rowcount
        conn.commit()
        cursor.close()
        return inserted
        
    except Exception as e:
        conn.rollback()
        cursor.close()
        print(f"   ❌ Insert error: {str(e)}")
        return 0
    finally:
        cursor.close()

def main():
    """Main backfill workflow"""
    
    print('=' * 80)
    print('BACKFILL MISSING HISTORICAL DATA')
    print('=' * 80)
    print()
    
    # Connect to database
    try:
        conn = psycopg2.connect(os.getenv('PG_DSN'))
        print("✅ Connected to database")
    except Exception as e:
        print(f"❌ Database connection failed: {str(e)}")
        return 1
    
    print("=" * 80)
    print("PHASE 1: FETCHING DATA FROM POLYGON.IO")
    print("=" * 80)
    print()
    
    # PHASE 1: Fetch all data first
    all_data = {}  # Store {(symbol, provider_ticker): bars}
    
    for group_name, group_config in BACKFILL_GROUPS.items():
        symbols = group_config['symbols']
        from_date = group_config['from_date']
        to_date = group_config['to_date']
        tickers = group_config['provider_tickers']
        
        print(f"{'=' * 80}")
        print(f"GROUP: {group_name.upper()}")
        print(f"Date range: {from_date} to {to_date}")
        print(f"Assets: {', '.join(symbols)}")
        print(f"{'=' * 80}")
        print()
        
        for symbol in symbols:
            provider_ticker = tickers[symbol]
            
            # Fetch from API
            bars = fetch_bars_from_massive(provider_ticker, from_date, to_date)
            
            if bars:
                all_data[(symbol, provider_ticker)] = bars
                print(f"📊 {symbol}: ✅ Downloaded {len(bars)} bars")
            else:
                print(f"📊 {symbol}: ⚠️  No data returned from API")
            
            # Rate limiting between requests
            time.sleep(0.5)
        
        print()
    
    print("=" * 80)
    print("PHASE 2: INSERTING DATA INTO DATABASE")
    print("=" * 80)
    print()
    
    total_inserted = 0
    
    # PHASE 2: Insert data one asset at a time with delays
    for (symbol, provider_ticker), bars in all_data.items():
        if not bars:
            continue
        
        print(f"Inserting {symbol} ({len(bars)} bars)...", end=' ', flush=True)
        inserted = insert_bars_batch(conn, symbol, provider_ticker, bars, '1m')
        print(f"✅ {inserted} bars inserted")
        total_inserted += inserted
        
        # Delay between each asset insert
        time.sleep(3)
    
    # Summary
    print()
    print('=' * 80)
    print('BACKFILL SUMMARY')
    print('=' * 80)
    print(f"Total bars inserted: {total_inserted}")
    print()
    
    # Verify
    cursor = conn.cursor()
    cursor.execute('''
        SELECT canonical_symbol, MIN(ts_utc) as earliest, MAX(ts_utc) as latest, COUNT(*) as total_bars
        FROM data_bars
        WHERE canonical_symbol IN ('BTC', 'AUDNZD', 'NZDUSD', 'XAGUSD', 'EURUSD', 'GBPUSD', 'USDCAD', 'USDCHF', 'USDJPY', 'USDSEK', 'XAUUSD')
        GROUP BY canonical_symbol
        ORDER BY canonical_symbol;
    ''')
    
    print("Verification - Data coverage after backfill:")
    print('-' * 80)
    for row in cursor.fetchall():
        symbol, earliest, latest, total = row
        if earliest:
            earliest_str = earliest.strftime('%Y-%m-%d %H:%M:%S')
            latest_str = latest.strftime('%Y-%m-%d %H:%M:%S')
            print(f"  {symbol:10s}: {earliest_str} to {latest_str} ({total:6d} bars)")
        else:
            print(f"  {symbol:10s}: NO DATA")
    
    cursor.close()
    conn.close()
    
    print()
    print("✅ Backfill complete!")
    return 0

if __name__ == '__main__':
    sys.exit(main())
