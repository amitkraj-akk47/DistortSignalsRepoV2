/**
 * Storage Layer
 * Handles persistence of validation results to quality_data_validation table
 */
import type { RPCResult } from './rpc-caller';

export interface ValidationRecord {
  run_id: string;
  run_timestamp: string;
  env_name: string;
  validation_type: 'quick_health' | 'daily_correctness' | 'weekly_deep';
  check_category: string;
  canonical_symbol?: string;
  timeframe?: string;
  table_name?: string;
  status: 'pass' | 'warning' | 'critical' | 'HARD_FAIL' | 'error';
  severity_gate: 'normal' | 'HARD_FAIL';
  issue_count: number;
  result_summary: Record<string, unknown>;
  issue_details: unknown[];
  execution_duration_ms: number;
}

/**
 * Store validation result in quality_data_validation table
 */
export async function storeValidationResult(
  client: any,
  record: ValidationRecord
): Promise<boolean> {
  try {
    const query = `
      INSERT INTO quality_data_validation (
        run_id,
        run_timestamp,
        env_name,
        validation_type,
        check_category,
        canonical_symbol,
        timeframe,
        table_name,
        status,
        severity_gate,
        issue_count,
        result_summary,
        issue_details,
        execution_duration_ms
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (run_id, check_category) DO UPDATE SET
        status = EXCLUDED.status,
        issue_count = EXCLUDED.issue_count,
        result_summary = EXCLUDED.result_summary,
        issue_details = EXCLUDED.issue_details,
        execution_duration_ms = EXCLUDED.execution_duration_ms,
        updated_at = NOW()
    `;
    
    await client.query(query, [
      record.run_id,
      record.run_timestamp,
      record.env_name,
      record.validation_type,
      record.check_category,
      record.canonical_symbol || null,
      record.timeframe || null,
      record.table_name || null,
      record.status,
      record.severity_gate,
      record.issue_count,
      JSON.stringify(record.result_summary),
      JSON.stringify(record.issue_details),
      record.execution_duration_ms,
    ]);
    
    return true;
  } catch (error) {
    console.error(
      `Failed to store validation result for ${record.check_category}:`,
      error
    );
    return false;
  }
}

/**
 * Store batch of validation results
 */
export async function storeValidationBatch(
  client: any,
  records: ValidationRecord[]
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;
  
  for (const record of records) {
    const success = await storeValidationResult(client, record);
    if (success) {
      succeeded++;
    } else {
      failed++;
    }
  }
  
  return { succeeded, failed };
}

/**
 * Fetch latest validation results (for dashboard/alerts)
 */
export async function getLatestValidationResults(
  client: any,
  envName: string,
  limit = 100
): Promise<ValidationRecord[]> {
  try {
    const query = `
      SELECT * FROM quality_data_validation
      WHERE env_name = $1
      ORDER BY run_timestamp DESC
      LIMIT $2
    `;
    
    const result = await client.query(query, [envName, limit]);
    return result.rows as unknown as ValidationRecord[];
  } catch (error) {
    console.error('Failed to fetch validation results:', error);
    return [];
  }
}

/**
 * Fetch results filtered by status and category
 */
export async function getValidationResultsByStatus(
  client: any,
  envName: string,
  status: string,
  hoursAgo = 24
): Promise<ValidationRecord[]> {
  try {
    const query = `
      SELECT * FROM quality_data_validation
      WHERE env_name = $1
        AND status = $2
        AND run_timestamp > NOW() - (($3 || ' hours')::INTERVAL)
      ORDER BY run_timestamp DESC
    `;
    
    const result = await client.query(query, [envName, status, hoursAgo]);
    return result.rows as unknown as ValidationRecord[];
  } catch (error) {
    console.error('Failed to fetch validation results by status:', error);
    return [];
  }
}

/**
 * Get HARD_FAIL alerts (for minimal alerting system)
 */
export async function getHARDFAILAlerts(
  client: any,
  envName: string,
  hoursSince = 1
): Promise<ValidationRecord[]> {
  try {
    const query = `
      SELECT * FROM quality_data_validation
      WHERE env_name = $1
        AND severity_gate = 'HARD_FAIL'
        AND run_timestamp > NOW() - (($2 || ' hours')::INTERVAL)
      ORDER BY run_timestamp DESC
    `;
    
    const result = await client.query(query, [envName, hoursSince]);
    return result.rows as unknown as ValidationRecord[];
  } catch (error) {
    console.error('Failed to fetch HARD_FAIL alerts:', error);
    return [];
  }
}

/**
 * Clean up old validation records (retention policy: 90 days)
 * Cleans quality_workerhealth and quality_check_results tables
 */
export async function cleanupOldValidationRecords(
  client: any,
  retentionDays = 90
): Promise<number> {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    const cutoffISO = cutoffDate.toISOString();
    
    // Delete old worker health records
    const { data: healthData, error: healthError } = await client
      .from('quality_workerhealth')
      .delete()
      .lt('created_at', cutoffISO)
      .select('id');
    
    if (healthError) {
      console.warn('Failed to cleanup quality_workerhealth:', healthError.message);
    }
    
    // Delete old check results
    const { data: resultsData, error: resultsError } = await client
      .from('quality_check_results')
      .delete()
      .lt('created_at', cutoffISO)
      .select('id');
    
    if (resultsError) {
      console.warn('Failed to cleanup quality_check_results:', resultsError.message);
    }
    
    const totalDeleted = (healthData?.length || 0) + (resultsData?.length || 0);
    
    if (totalDeleted > 0) {
      console.info(`Cleaned up ${totalDeleted} old validation records`);
    }
    
    return totalDeleted;
  } catch (error) {
    console.error('Failed to cleanup old validation records:', error);
    return 0;
  }
}
