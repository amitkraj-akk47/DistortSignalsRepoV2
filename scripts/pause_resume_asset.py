#!/usr/bin/env python3
"""
Script to pause or resume data fetching for specific assets
Usage: python pause_resume_asset.py [pause|resume] SYMBOL [SYMBOL...]
"""

import os
import sys
from dotenv import load_dotenv
import psycopg2

def main():
    if len(sys.argv) < 3:
        print("Usage: python pause_resume_asset.py [pause|resume] SYMBOL [SYMBOL...]")
        print("\nExamples:")
        print("  python pause_resume_asset.py pause AUDNZD BTC")
        print("  python pause_resume_asset.py resume XAGUSD")
        sys.exit(1)
    
    action = sys.argv[1].lower()
    symbols = sys.argv[2:]
    
    if action not in ['pause', 'resume']:
        print(f"Error: Invalid action '{action}'. Use 'pause' or 'resume'")
        sys.exit(1)
    
    pause_value = (action == 'pause')
    
    load_dotenv('scripts/.env')
    conn = psycopg2.connect(os.getenv('PG_DSN'))
    cursor = conn.cursor()
    
    print(f"\n{'Pausing' if pause_value else 'Resuming'} data fetch for {len(symbols)} asset(s):")
    print("=" * 70)
    
    for symbol in symbols:
        try:
            # Check if record exists
            cursor.execute('''
                SELECT canonical_symbol, timeframe, status, pause_fetch 
                FROM data_ingest_state 
                WHERE canonical_symbol = %s;
            ''', (symbol,))
            
            rows = cursor.fetchall()
            
            if not rows:
                print(f"⚠️  {symbol}: No state records found (asset may need to run once first)")
                continue
            
            # Update all timeframes for this symbol
            cursor.execute('''
                UPDATE data_ingest_state 
                SET pause_fetch = %s,
                    notes = CASE 
                        WHEN %s THEN 'Data fetching PAUSED by user on ' || NOW()::text
                        ELSE 'Data fetching RESUMED by user on ' || NOW()::text
                    END,
                    updated_at = NOW()
                WHERE canonical_symbol = %s;
            ''', (pause_value, pause_value, symbol))
            
            updated_count = cursor.rowcount
            conn.commit()
            
            status_word = 'PAUSED' if pause_value else 'RESUMED'
            print(f"✅ {symbol}: {status_word} ({updated_count} timeframe(s) updated)")
            
            # Show current state
            for row in rows:
                sym, tf, status, old_pause = row
                new_pause = pause_value
                print(f"   {tf}: status={status}, pause_fetch: {old_pause} → {new_pause}")
        
        except Exception as e:
            print(f"❌ {symbol}: Error - {str(e)}")
            conn.rollback()
    
    print("\n" + "=" * 70)
    print(f"Done! Worker will {'skip' if pause_value else 'resume'} API fetching on next run.")
    print("\nTo verify status:")
    print(f"  SELECT canonical_symbol, timeframe, status, pause_fetch, notes")
    print(f"  FROM data_ingest_state")
    print(f"  WHERE canonical_symbol IN ({', '.join(repr(s) for s in symbols)});")
    
    cursor.close()
    conn.close()

if __name__ == '__main__':
    main()
