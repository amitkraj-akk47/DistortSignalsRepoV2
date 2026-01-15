/**
 * Data Quality Validator Cloudflare Worker
 * Main entry point for scheduled and manual validation triggers
 */

import { initHyperdrive } from './rpc-caller';
import { runValidationSuite } from './scheduler';
import {
  getLatestValidationResults,
  getHARDFAILAlerts,
  cleanupOldValidationRecords,
} from './storage';

/**
 * Cron handler - Automatically triggered by Wrangler based on configured schedule
 * Single cron: */5 * * * * (every 5 minutes)
 * Mode determined by minute: :00 and :30 = full mode, others = fast mode
 */
export async function scheduled(
  event: any,
  env: any,
  ctx: any
): Promise<void> {
  try {
    const client = await initHyperdrive(env);
    const envName = env.ENVIRONMENT === 'production' ? 'prod' : 'dev';
    const scheduledTime = event.scheduledTime;
    
    console.info(
      `[cron] Validation suite starting (env: ${envName}, time: ${new Date(scheduledTime).toISOString()})`
    );
    
    // Execute validation suite (mode determined by minute)
    const result = await runValidationSuite(client, envName, scheduledTime);
    
    console.info(
      `[cron] Suite "${result.suite}" completed: ${result.status} (${result.totalDurationMs}ms, ${result.resultsCount} checks)`
    );
    
    // Perform daily cleanup at 5 AM UTC
    if (new Date().getUTCHours() === 5) {
      const deleted = await cleanupOldValidationRecords(client, 90);
      if (deleted > 0) {
        console.info(`[cron] Cleaned up ${deleted} old validation records`);
      }
    }
  } catch (error) {
    console.error('[cron] Validation suite failed:', error);
    // Non-blocking error: log for monitoring, don't crash the worker
  }
}

/**
 * HTTP handler - Manual trigger and dashboard API
 */
export async function fetch(
  request: Request,
  env: any,
  ctx: any
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const envName = env.ENVIRONMENT === 'production' ? 'prod' : 'dev';
  
  try {
    const client = await initHyperdrive(env);
    
    // Manual trigger: POST /validate
    if (path === '/validate' && request.method === 'POST') {
      let suite: string | undefined;
      try {
        const body = await request.json() as { suite?: string };
        suite = body.suite;
      } catch {
        // No JSON body is OK
      }
      return handleManualValidation(client, envName, suite);
    }
    
    // Dashboard API: GET /results
    if (path === '/results' && request.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);
      return handleGetResults(client, envName, limit);
    }
    
    // Dashboard API: GET /alerts
    if (path === '/alerts' && request.method === 'GET') {
      const hours = parseInt(url.searchParams.get('hours') || '1', 10);
      return handleGetAlerts(client, envName, hours);
    }
    
    // Health check
    if (path === '/health' && request.method === 'GET') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          environment: env.ENVIRONMENT,
          timestamp: new Date().toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    return new Response(
      JSON.stringify({
        error: 'Not Found',
        endpoints: {
          'POST /validate': 'Manually trigger validation suite',
          'GET /results': 'Fetch latest validation results',
          'GET /alerts': 'Fetch HARD_FAIL alerts',
          'GET /health': 'Health check',
        },
      }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[http] Request failed:', error);
    return new Response(
      JSON.stringify({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Handle manual validation trigger
 */
async function handleManualValidation(
  client: any,
  envName: string,
  suite?: string
): Promise<Response> {
  try {
    const result = await runValidationSuite(client, envName);
    
    return new Response(
      JSON.stringify({
        message: 'Validation suite executed',
        result: {
          suite: result.suite,
          runId: result.runId,
          status: result.status,
          totalDurationMs: result.totalDurationMs,
          resultsCount: result.resultsCount,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Validation failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Handle get results request
 */
async function handleGetResults(
  client: any,
  envName: string,
  limit: number
): Promise<Response> {
  try {
    const results = await getLatestValidationResults(
      client,
      envName,
      Math.min(limit, 1000)
    );
    
    return new Response(
      JSON.stringify({
        count: results.length,
        results,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Failed to fetch results',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Handle get alerts request
 */
async function handleGetAlerts(
  client: any,
  envName: string,
  hours: number
): Promise<Response> {
  try {
    const alerts = await getHARDFAILAlerts(client, envName, hours);
    
    return new Response(
      JSON.stringify({
        count: alerts.length,
        alerts,
        message: alerts.length === 0 ? 'No HARD_FAIL alerts' : undefined,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Failed to fetch alerts',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// Export handlers for Wrangler
export default { fetch, scheduled };
