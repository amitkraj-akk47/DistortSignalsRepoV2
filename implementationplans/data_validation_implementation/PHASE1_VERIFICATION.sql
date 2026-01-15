-- Phase 1 Step 2: Verify SQL Deployment
-- Run these checks in Supabase SQL editor to confirm all objects were created successfully

-- 1. Verify Tables Created
SELECT 
  table_name,
  (
    SELECT count(*) 
    FROM information_schema.columns 
    WHERE table_name = t.table_name
  ) as column_count
FROM information_schema.tables t
WHERE table_schema = 'public'
  AND table_name IN ('quality_workerhealth', 'quality_check_results', 'ops_issues')
ORDER BY table_name;

-- Expected output: 3 rows (one for each quality table)

---

-- 2. Verify Indexes Created
SELECT 
  indexname,
  tablename
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname LIKE 'idx_%'
ORDER BY tablename, indexname;

-- Expected output: 10 index rows

---

-- 3. Verify RPC Functions Created
SELECT 
  routine_name,
  routine_type,
  security_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name LIKE 'rpc_%'
ORDER BY routine_name;

-- Expected output: 12 functions (2 helpers + 9 validation + 1 orchestrator)

---

-- 4. Verify Row-Level Security Enabled
SELECT 
  schemaname,
  tablename,
  rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('quality_workerhealth', 'quality_check_results', 'ops_issues')
ORDER BY tablename;

-- Expected output: 3 rows, all with rowsecurity = true

---

-- 5. Quick RPC Test (Staleness Check)
-- This tests the basic RPC execution
SELECT 
  jsonb_pretty(
    rpc_check_staleness('production', 5, 15, 100, true)
  ) as staleness_check_result;

-- Expected output: JSONB with check results
-- Status should be 'pass', 'warning', 'critical', or 'error'

---

-- If all 5 verification steps succeed ✅
-- Phase 1 is COMPLETE - Proceed to Phase 2: Worker Deployment
