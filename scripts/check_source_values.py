#!/usr/bin/env python3
import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

load_dotenv()

def get_conn():
    dsn = os.getenv("PG_DSN")
    if dsn:
        return psycopg2.connect(dsn, cursor_factory=RealDictCursor)
    
    host = os.getenv("PGHOST")
    user = os.getenv("PGUSER")
    pwd = os.getenv("PGPASSWORD")
    db = os.getenv("PGDATABASE", "postgres")
    
    return psycopg2.connect(
        host=host,
        user=user,
        password=pwd,
        database=db,
        cursor_factory=RealDictCursor
    )

conn = get_conn()
cur = conn.cursor()

cur.execute("""
    SELECT source, COUNT(*) as count
    FROM derived_data_bars
    GROUP BY source
    ORDER BY count DESC
""")

print('Current source values in derived_data_bars:')
for row in cur.fetchall():
    print(f"  '{row['source']}': {row['count']} rows")

conn.close()
