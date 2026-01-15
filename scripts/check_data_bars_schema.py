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
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'data_bars'
    ORDER BY ordinal_position
""")

print('data_bars columns:')
for row in cur.fetchall():
    print(f"  {row['column_name']}: {row['data_type']}")

conn.close()
