/**
 * Scheduler - Data Quality Validation Worker
 * 
 * Executes rpc_run_health_checks orchestrator RPC
 * Single cron: every 5 minutes
 * Mode determined by minute: at 00 and 30 = full mode, others = fast mode
 */

import { executeRPC } from './rpc-caller';
import type { RPCCall } from './rpc-caller';

// UUID generator for Cloudflare Workers
export function generateUUID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Determine execution mode based on UTC minute
 * Every 5 minutes, but:
 * - At :00 and :30 → full mode (all 9 checks)
 * - Other times → fast mode (5 core checks)
 */
export function getModeFromTime(now = new Date()): 'fast' | 'full' {
  const minute = now.getUTCMinutes();

  // Full mode at :00 and :30 (every 30 minutes)
  if (minute % 30 === 0) {
    return 'full';
  }

  // Fast mode at all other 5-minute intervals
  return 'fast';
}

/**
 * Execute the complete health check suite via orchestrator RPC
 * This is the main entry point for validation execution
 */
export async function runValidationSuite(
  client: any,
  envName: string,
  scheduledTime?: number
): Promise<{
  suite: 'fast' | 'full' | 'none';
  status: 'pass' | 'warning' | 'critical' | 'HARD_FAIL' | 'error';
  totalDurationMs: number;
  resultsCount: number;
  runId?: string;
}> {
  const now = new Date(scheduledTime || Date.now());
  const mode = getModeFromTime(now);
  const runId = generateUUID();
  const startTime = performance.now();

  console.info(
    `[${runId}] Health check suite starting (mode: ${mode}, env: ${envName}, time: ${now.toISOString()})`
  );

  try {
    // Call the orchestrator RPC
    const rpc: RPCCall = {
      name: 'rpc_run_health_checks',
      query: 'SELECT rpc_run_health_checks($1, $2, $3) as result',
      params: [envName, mode, 'cron'],
      timeoutMs: 65000, // Slightly more than orchestrator's 60s timeout
      retries: 1, // Minimal retries on orchestrator (stateful)
    };

    const result = await executeRPC(client, rpc, envName);

    const totalDurationMs = Math.round(performance.now() - startTime);

    // Parse orchestrator result
    if (result.status === 'error') {
      console.error(`[${runId}] Orchestrator failed:`, result.error_message);
      return {
        suite: mode,
        status: 'error',
        totalDurationMs,
        resultsCount: 0,
        runId,
      };
    }

    const checksCount = (result.result_summary as any)?.checks_run || 0;
    const issueCount = (result.result_summary as any)?.issue_count || 0;

    console.info(
      `[${runId}] Health checks complete (${mode}): status=${result.status}, checks=${checksCount}, issues=${issueCount}, duration=${totalDurationMs}ms`
    );

    // Alert on HARD_FAIL
    if (result.status === 'HARD_FAIL') {
      console.error(
        `[${runId}] 🚨 HARD_FAIL detected - Architecture violation in data quality validation`
      );
    }

    return {
      suite: mode,
      status: result.status,
      totalDurationMs,
      resultsCount: checksCount,
      runId,
    };
  } catch (error) {
    const totalDurationMs = Math.round(performance.now() - startTime);
    const errorMsg = error instanceof Error ? error.message : String(error);

    console.error(
      `[${runId}] Validation suite execution failed: ${errorMsg} (${totalDurationMs}ms)`
    );

    return {
      suite: mode,
      status: 'error',
      totalDurationMs,
      resultsCount: 0,
      runId,
    };
  }
}
