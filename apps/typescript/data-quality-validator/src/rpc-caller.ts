/**
 * RPC Caller Utility
 * Handles database connection via Supabase client (through Hyperdrive) and RPC invocation
 * Implements retry logic and performance monitoring
 */

import { createClient } from '@supabase/supabase-js';

export interface RPCResult {
  status: 'pass' | 'warning' | 'critical' | 'HARD_FAIL' | 'error';
  check_category: string;
  issue_count: number;
  result_summary: Record<string, unknown>;
  issue_details: unknown[];
  error_message?: string;
  execution_time_ms?: number;
}

export interface RPCCall {
  name: string;
  query: string;
  params: unknown[];
  timeoutMs?: number;
  retries?: number;
}

export interface RPCExecutionContext {
  env_name: string;
  execution_start: Date;
  requests: RPCCall[];
  results: Map<string, RPCResult>;
  total_execution_ms?: number;
}

/**
 * Initialize Supabase client using Hyperdrive connection
 */
export async function initHyperdrive(
  env: any
): Promise<any> {
  const hyperdrive = env.HYPERDRIVE;

  if (!hyperdrive) {
    throw new Error(
      'HYPERDRIVE binding not configured. Check wrangler.toml'
    );
  }

  // Create Supabase client using Hyperdrive's connection string
  // Hyperdrive provides connectionString property
  const connectionString = hyperdrive.connectionString;
  
  // Extract host from connection string to build Supabase URL
  // Format: postgres://user:pass@host:port/db
  const match = connectionString.match(/postgres:\/\/[^@]+@([^:]+)/);
  const host = match ? match[1] : null;
  
  if (!host) {
    throw new Error('Could not extract host from Hyperdrive connection string');
  }

  // Build Supabase REST API URL from pooler host
  // Convert: xyz.pooler.supabase.com -> https://xyz.supabase.co
  const supabaseUrl = `https://${host.replace('.pooler.supabase.com', '.supabase.co')}`;
  
  // Use service role key from environment
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
    db: {
      schema: 'public'
    }
  });
}
/**
 * Execute a single RPC with retry logic and timeout
 */
export async function executeRPC(
  client: any,
  rpc: RPCCall,
  envName: string
): Promise<RPCResult> {
  const startTime = performance.now();
  const maxRetries = rpc.retries || 3;
  const timeoutMs = rpc.timeoutMs || 10000;
  
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Execute RPC with timeout using Supabase client
      const rpcName = rpc.name;
      
      // Build RPC parameters object based on the RPC signature
      // For orchestrator: p_env_name, p_mode, p_trigger
      // For individual checks: p_env_name, p_*_warn, p_*_critical, p_limit_rows, p_respect_fx_weekend
      const rpcParams: Record<string, any> = {};
      
      if (rpcName === 'rpc_run_health_checks') {
        // Orchestrator parameters
        rpcParams.p_env_name = rpc.params[0];
        rpcParams.p_mode = rpc.params[1];
        rpcParams.p_trigger = rpc.params[2];
      } else {
        // Individual check parameters (generic mapping)
        rpcParams.p_env_name = rpc.params[0];
        if (rpc.params.length > 1) rpcParams.p_param1 = rpc.params[1];
        if (rpc.params.length > 2) rpcParams.p_param2 = rpc.params[2];
        if (rpc.params.length > 3) rpcParams.p_param3 = rpc.params[3];
        if (rpc.params.length > 4) rpcParams.p_param4 = rpc.params[4];
      }
      
      const { data, error } = await Promise.race([
        client.rpc(rpcName, rpcParams),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`RPC timeout after ${timeoutMs}ms`)),
            timeoutMs
          )
        ) as Promise<{ data: any; error: any }>,
      ]);
      
      if (error) {
        throw new Error(error.message);
      }
      
      const executionTime = performance.now() - startTime;
      
      // Supabase RPC returns data directly (JSONB from function)
      const rpcResult = data || {};
      
      return {
        ...(rpcResult as RPCResult),
        execution_time_ms: Math.round(executionTime),
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Log retry attempt
      console.warn(
        `RPC ${rpc.name} attempt ${attempt}/${maxRetries} failed: ${lastError.message}`
      );
      
      // Exponential backoff for retries
      if (attempt < maxRetries) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, attempt - 1) * 100)
        );
      }
    }
  }
  
  // All retries exhausted
  const executionTime = performance.now() - startTime;
  return {
    status: 'error',
    check_category: rpc.name.replace('rpc_check_', ''),
    issue_count: 0,
    result_summary: {},
    issue_details: [],
    error_message: `RPC failed after ${maxRetries} attempts: ${lastError?.message}`,
    execution_time_ms: Math.round(executionTime),
  };
}

/**
 * Execute multiple RPCs in sequence
 */
export async function executeRPCBatch(
  client: any,
  rpcs: RPCCall[],
  envName: string,
  timeoutMs = 30000
): Promise<Map<string, RPCResult>> {
  const results = new Map<string, RPCResult>();
  const batchStartTime = performance.now();
  
  for (const rpc of rpcs) {
    const remainingTime = timeoutMs - (performance.now() - batchStartTime);
    
    if (remainingTime <= 0) {
      // Batch timeout exceeded
      results.set(rpc.name, {
        status: 'error',
        check_category: rpc.name.replace('rpc_check_', ''),
        issue_count: 0,
        result_summary: {},
        issue_details: [],
        error_message: 'Batch timeout exceeded',
        execution_time_ms: timeoutMs,
      });
      continue;
    }
    
    const result = await executeRPC(client, rpc, envName);
    results.set(rpc.name, result);
  }
  
  return results;
}

/**
 * Get RPC definitions for quick health checks
 * Run every 15 minutes at :03, :18, :33, :48
 */
export function getQuickHealthRPCs(): RPCCall[] {
  return [
    {
      name: 'rpc_check_staleness',
      query: 'SELECT rpc_check_staleness($1, 20, 5, 15)',
      params: [],
      timeoutMs: 2000,
      retries: 2,
    },
    {
      name: 'rpc_check_architecture_gates',
      query: 'SELECT rpc_check_architecture_gates($1)',
      params: [],
      timeoutMs: 2000,
      retries: 2,
    },
    {
      name: 'rpc_check_duplicates',
      query: 'SELECT rpc_check_duplicates($1, 7)',
      params: [],
      timeoutMs: 1000,
      retries: 2,
    },
  ];
}

/**
 * Get RPC definitions for daily correctness checks
 * Run at 3 AM UTC
 */
export function getDailyCorrectnessRPCs(toleranceMode = 'strict'): RPCCall[] {
  return [
    {
      name: 'rpc_check_staleness',
      query: 'SELECT rpc_check_staleness($1, 20, 5, 15)',
      params: [],
      timeoutMs: 2000,
      retries: 2,
    },
    {
      name: 'rpc_check_architecture_gates',
      query: 'SELECT rpc_check_architecture_gates($1)',
      params: [],
      timeoutMs: 2000,
      retries: 2,
    },
    {
      name: 'rpc_check_duplicates',
      query: 'SELECT rpc_check_duplicates($1, 7)',
      params: [],
      timeoutMs: 1000,
      retries: 2,
    },
    {
      name: 'rpc_check_dxy_components',
      query: 'SELECT rpc_check_dxy_components($1, 7, $2)',
      params: [toleranceMode],
      timeoutMs: 3000,
      retries: 2,
    },
    {
      name: 'rpc_check_aggregation_reconciliation_sample',
      query: 'SELECT rpc_check_aggregation_reconciliation_sample($1, 7, 50, $2::jsonb)',
      params: ['{"rel_high_low": 0.0001, "abs_high_low": 0.000001, "rel_open_close": 0.0001}'],
      timeoutMs: 5000,
      retries: 2,
    },
    {
      name: 'rpc_check_ohlc_integrity_sample',
      query: 'SELECT rpc_check_ohlc_integrity_sample($1, 7, 5000, 0.10)',
      params: [],
      timeoutMs: 2000,
      retries: 2,
    },
  ];
}

/**
 * Get RPC definitions for weekly deep checks
 * Run Sunday 4 AM UTC
 * NOTE: Start conservative (4 weeks), profile, expand to 12 weeks
 */
export function getWeeklyDeepRPCs(windowWeeks = 4): RPCCall[] {
  return [
    {
      name: 'rpc_check_gap_density',
      query: 'SELECT rpc_check_gap_density($1, $2, 10)',
      params: [windowWeeks],
      timeoutMs: 6000,
      retries: 1,
    },
    {
      name: 'rpc_check_coverage_ratios',
      query: 'SELECT rpc_check_coverage_ratios($1, $2, 95.0)',
      params: [windowWeeks],
      timeoutMs: 4000,
      retries: 1,
    },
    {
      name: 'rpc_check_historical_integrity_sample',
      query: 'SELECT rpc_check_historical_integrity_sample($1, $2, 10000, 0.10)',
      params: [windowWeeks],
      timeoutMs: 8000,
      retries: 1,
    },
  ];
}

/**
 * Create JSONB payload for quality_data_validation table insertion
 */
export function createValidationPayload(
  runId: string,
  rpcName: string,
  result: RPCResult
): {
  run_id: string;
  run_timestamp: string;
  env_name: string;
  validation_type: string;
  check_category: string;
  status: string;
  severity_gate: string;
  issue_count: number;
  result_summary: Record<string, unknown>;
  issue_details: unknown[];
  execution_duration_ms: number;
} {
  return {
    run_id: runId,
    run_timestamp: new Date().toISOString(),
    env_name: 'unknown', // Will be filled by scheduler
    validation_type: 'quick_health', // Will be overridden by caller
    check_category: result.check_category,
    status: result.status,
    severity_gate: result.status === 'HARD_FAIL' ? 'HARD_FAIL' : 'normal',
    issue_count: result.issue_count,
    result_summary: result.result_summary,
    issue_details: result.issue_details,
    execution_duration_ms: result.execution_time_ms || 0,
  };
}
