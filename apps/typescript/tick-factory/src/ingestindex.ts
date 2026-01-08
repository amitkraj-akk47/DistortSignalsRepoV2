/**
 * DistortSignals Market Data Ingestion Worker
 * 
 * Production-ready Cloudflare Worker for ingesting market data from Massive
 * Supports Class A (1-minute) and Class B (5-minute) assets.
 * 
 * @version 1.0.0
 * @author DistortSignals
 */

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface Env {
  // Required
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  MASSIVE_KEY: string;

  // Security
  INTERNAL_API_KEY?: string;
  ALLOWED_PROVIDER_HOSTS?: string;
  MAX_RESPONSE_BYTES?: string;
  LOG_URL_MODE?: string;

  // Job configuration
  JOB_NAME?: string;
  MAX_ASSETS_PER_RUN?: string;
  REQUEST_TIMEOUT_MS?: string;
  LOCK_LEASE_SECONDS?: string;
  ASSET_ACTIVE_FIELD?: string;
  MAX_RUN_BUDGET_MS?: string;
  HARD_DISABLE_STREAK?: string;
  FETCH_COOLDOWN_SECONDS?: string;
  
  // Issues tracking
  ENABLE_ISSUES?: string;
  
  // Logging configuration
  LOG_LEVEL?: string;         // "DEBUG" | "INFO" | "WARN" | "ERROR" (default: INFO)
  PROGRESS_INTERVAL?: string; // Log progress every N assets (default: 10)
}

type Json = Record<string, unknown>;

interface AssetRow {
  canonical_symbol: string;
  provider_ticker: string | null;
  asset_class: string;
  source: string;
  endpoint_key: string;
  query_params: Json;
  active: boolean;
  test_active: boolean;
  ingest_class: string | null;
  base_timeframe: string | null;
  is_sparse: boolean;
  is_contract: boolean;
  expected_update_seconds: number | null;
}

interface EndpointRow {
  endpoint_key: string;
  source: string;
  base_url: string;
  path_template: string;
  default_params: Json;
  auth_mode: string;
  active: boolean;
}

interface IngestStateRow {
  canonical_symbol: string;
  timeframe: string;
  last_bar_ts_utc: string | null;
  last_run_at_utc: string | null;
  status: string;
  last_error: string | null;
  updated_at: string;
  hard_fail_streak: number;
  last_attempted_to_utc?: string | null;
  last_successful_to_utc?: string | null;
}

interface FetchRetryResult {
  ok: boolean;
  status: number | "ERR";
  json?: unknown;
  latencyMs: number;
  err?: string;
  attempts: number;
  backoffTotalSec: number;
}

interface RunCounts {
  assets_total: number;
  assets_attempted: number;
  assets_succeeded: number;
  assets_failed: number;
  assets_skipped: number;
  assets_disabled: number;
  http_429: number;
  rows_written: number;
  duration_ms: number;
  skip_reasons: Record<string, number>;
}

// ============================================================================
// UTILITIES
// ============================================================================

function nowUtc(): Date {
  return new Date();
}

function toIso(d: Date): string {
  return d.toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function floorToBoundary(d: Date, tfSeconds: number): Date {
  const step = tfSeconds * 1000;
  return new Date(Math.floor(d.getTime() / step) * step);
}

function alignIsoToDateYYYYMMDD(iso: string): string {
  return iso.slice(0, 10);
}

function tfToSeconds(tf: "1m" | "5m"): number {
  return tf === "1m" ? 60 : 300;
}

function boolEnv(v: string | undefined, def = false): boolean {
  if (v == null) return def;
  return ["1", "true", "yes", "y", "on"].includes(v.toLowerCase());
}

function numEnv(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function strEnv(v: string | undefined, def: string): string {
  return (v ?? def).trim();
}

// ============================================================================
// STRUCTURED LOGGING
// ============================================================================

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

interface LogContext {
  phase?: string;
  asset?: string;
  timeframe?: string;
  runId?: string;
  step?: string;
}

/**
 * Structured logger for clear, traceable output.
 * Use with `wrangler tail` to see real-time logs.
 * 
 * Features:
 * - Log level filtering via LOG_LEVEL env var
 * - Progress sampling (logs every N assets to reduce noise)
 * - Per-asset timing metrics
 * 
 * Output format: [LEVEL] [PHASE] [STEP] message {context}
 */
class Logger {
  private runId: string | null = null;
  private currentAsset: string | null = null;
  private currentPhase: string = "INIT";
  private assetIndex: number = 0;
  private assetTotal: number = 0;
  private minLevel: LogLevel;
  private progressInterval: number;
  
  // Timing tracking
  private assetStartTime: number = 0;
  private assetTimings: number[] = [];

  constructor(minLevel: LogLevel = "INFO", progressInterval = 10) {
    this.minLevel = minLevel;
    this.progressInterval = progressInterval;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.minLevel];
  }

  setRunId(id: string): void {
    this.runId = id;
  }

  setPhase(phase: string): void {
    this.currentPhase = phase;
  }

  setAsset(symbol: string | null, index?: number, total?: number): void {
    this.currentAsset = symbol;
    if (index !== undefined) this.assetIndex = index;
    if (total !== undefined) this.assetTotal = total;
  }

  private formatMessage(level: LogLevel, step: string, message: string, data?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const assetInfo = this.currentAsset 
      ? `[${this.assetIndex}/${this.assetTotal}:${this.currentAsset}]` 
      : "";
    const runInfo = this.runId ? `[run:${this.runId.slice(0, 8)}]` : "";
    
    let line = `${timestamp} ${level.padEnd(5)} [${this.currentPhase}] ${assetInfo}${runInfo} ${step}: ${message}`;
    
    if (data && Object.keys(data).length > 0) {
      line += ` | ${JSON.stringify(data)}`;
    }
    
    return line;
  }

  debug(step: string, message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog("DEBUG")) return;
    console.log(this.formatMessage("DEBUG", step, message, data));
  }

  info(step: string, message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog("INFO")) return;
    console.log(this.formatMessage("INFO", step, message, data));
  }

  warn(step: string, message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog("WARN")) return;
    console.warn(this.formatMessage("WARN", step, message, data));
  }

  error(step: string, message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog("ERROR")) return;
    console.error(this.formatMessage("ERROR", step, message, data));
  }

  // Convenience methods for common log patterns
  phaseStart(phase: string, details?: Record<string, unknown>): void {
    this.setPhase(phase);
    this.info("START", `=== ${phase} ===`, details);
  }

  phaseEnd(phase: string, details?: Record<string, unknown>): void {
    this.info("END", `=== ${phase} complete ===`, details);
  }

  // Asset lifecycle with timing
  assetStart(symbol: string, index: number, total: number, details?: Record<string, unknown>): void {
    this.setAsset(symbol, index, total);
    this.assetStartTime = Date.now();
    
    // Log every asset at DEBUG level, but only every N assets at INFO level
    if (this.shouldLog("DEBUG")) {
      this.debug("ASSET_START", `Processing asset`, details);
    } else if (index === 1 || index % this.progressInterval === 0 || index === total) {
      // Always log first, last, and every Nth asset
      this.info("PROGRESS", `Processing asset ${index}/${total}`, { 
        symbol, 
        percent: Math.round((index / total) * 100),
        ...details 
      });
    }
  }

  assetSkip(reason: string, details?: Record<string, unknown>): void {
    const durationMs = Date.now() - this.assetStartTime;
    this.assetTimings.push(durationMs);
    this.warn("ASSET_SKIP", `Skipping: ${reason}`, { ...details, durationMs });
  }

  assetSuccess(details?: Record<string, unknown>): void {
    const durationMs = Date.now() - this.assetStartTime;
    this.assetTimings.push(durationMs);
    
    // Log every success at DEBUG, but sample at INFO level
    if (this.shouldLog("DEBUG")) {
      this.debug("ASSET_OK", `Asset completed successfully`, { ...details, durationMs });
    } else if (this.assetIndex === 1 || this.assetIndex % this.progressInterval === 0 || this.assetIndex === this.assetTotal) {
      this.info("ASSET_OK", `Asset completed`, { ...details, durationMs });
    }
  }

  assetFail(reason: string, details?: Record<string, unknown>): void {
    const durationMs = Date.now() - this.assetStartTime;
    this.assetTimings.push(durationMs);
    // Always log failures
    this.error("ASSET_FAIL", `Asset failed: ${reason}`, { ...details, durationMs });
  }

  // Progress indicator for long operations
  progress(current: number, total: number, label: string): void {
    const pct = Math.round((current / total) * 100);
    this.info("PROGRESS", `${label}: ${current}/${total} (${pct}%)`, { current, total, percent: pct });
  }

  // Get timing statistics at end of run
  getTimingStats(): { count: number; avgMs: number; minMs: number; maxMs: number; totalMs: number } {
    if (this.assetTimings.length === 0) {
      return { count: 0, avgMs: 0, minMs: 0, maxMs: 0, totalMs: 0 };
    }
    const totalMs = this.assetTimings.reduce((a, b) => a + b, 0);
    return {
      count: this.assetTimings.length,
      avgMs: Math.round(totalMs / this.assetTimings.length),
      minMs: Math.min(...this.assetTimings),
      maxMs: Math.max(...this.assetTimings),
      totalMs,
    };
  }

  // Log final timing summary
  logTimingSummary(): void {
    const stats = this.getTimingStats();
    if (stats.count > 0) {
      this.info("TIMING", `Asset timing stats`, {
        assetsProcessed: stats.count,
        avgMs: stats.avgMs,
        minMs: stats.minMs,
        maxMs: stats.maxMs,
        totalSec: Math.round(stats.totalMs / 1000),
      });
    }
  }
}

// Global logger instance - will be configured per run
let log = new Logger("INFO", 10);

// ============================================================================
// SECURITY
// ============================================================================

async function sha256Bytes(s: string): Promise<Uint8Array> {
  const enc = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  return new Uint8Array(hash);
}

async function timingSafeEquals(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) return false;
  const ha = await sha256Bytes(a);
  const hb = await sha256Bytes(b);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

async function isAuthorizedInternal(req: Request, env: Env): Promise<boolean> {
  const key = env.INTERNAL_API_KEY;
  if (!key) return false;
  const provided = req.headers.get("x-internal-api-key");
  if (!provided) return false;
  return await timingSafeEquals(provided, key);
}

function sanitizeUrlForLogging(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    ["apiKey", "key", "token", "secret", "authorization", "auth"].forEach((p) =>
      u.searchParams.delete(p)
    );
    return u.toString();
  } catch {
    return "invalid_url";
  }
}

async function sha256Hex(s: string): Promise<string> {
  const enc = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function urlForLogs(env: Env, url: string): Promise<string | null> {
  const mode = (env.LOG_URL_MODE || "sanitized").toLowerCase();
  if (mode === "none") return null;
  if (mode === "hash") return await sha256Hex(url);
  return sanitizeUrlForLogging(url);
}

function allowedProviderHosts(env: Env): Set<string> {
  const raw = (env.ALLOWED_PROVIDER_HOSTS || "api.massive.com")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(raw);
}

function isHostAllowlisted(env: Env, baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return allowedProviderHosts(env).has(u.hostname);
  } catch {
    return false;
  }
}

// ============================================================================
// SUPABASE REST CLIENT
// ============================================================================

class SupabaseRest {
  private url: string;
  private key: string;

  constructor(url: string, key: string) {
    this.url = url.replace(/\/+$/, "");
    this.key = key;
  }

  static fromEnv(env: Env): SupabaseRest {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Missing required environment variables: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
    return new SupabaseRest(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      ...(extra || {}),
    };
  }

  private async requireOk(r: Response, label: string, path: string): Promise<void> {
    if (r.ok) return;
    const detail = await r.text().catch(() => "");
    console.error(`${label} ${path} failed: ${r.status}`, detail.slice(0, 1500));
    throw new Error(`Database operation failed: ${r.status}`);
  }

  async get<T>(path: string): Promise<T> {
    const r = await fetch(`${this.url}${path}`, { headers: this.headers() });
    await this.requireOk(r, "GET", path);
    return (await r.json()) as T;
  }

  async post<T>(path: string, body: unknown, prefer = "return=minimal"): Promise<T> {
    const r = await fetch(`${this.url}${path}`, {
      method: "POST",
      headers: this.headers({ Prefer: prefer }),
      body: JSON.stringify(body),
    });
    await this.requireOk(r, "POST", path);
    if (prefer.includes("return=minimal")) {
      return {} as T;
    }
    return (await r.json()) as T;
  }

  async patch<T>(path: string, body: unknown, prefer = "return=minimal"): Promise<T> {
    const r = await fetch(`${this.url}${path}`, {
      method: "PATCH",
      headers: this.headers({ Prefer: prefer }),
      body: JSON.stringify(body),
    });
    await this.requireOk(r, "PATCH", path);
    if (prefer.includes("return=minimal")) {
      return {} as T;
    }
    return (await r.json()) as T;
  }

  async rpc<T>(fn: string, body: unknown, prefer = "return=representation"): Promise<T> {
    const r = await fetch(`${this.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: this.headers({ Prefer: prefer }),
      body: JSON.stringify(body),
    });
    await this.requireOk(r, "RPC", fn);
    return (await r.json()) as T;
  }
}

// ============================================================================
// OPS HELPERS
// ============================================================================

type LockResult = { acquired: true } | { acquired: false; reason: "contention" | "rpc_error"; error?: string };

async function opsAcquireLock(
  supa: SupabaseRest,
  jobName: string,
  leaseSeconds: number,
  lockedBy: string
): Promise<LockResult> {
  try {
    const result = await supa.rpc<boolean>("ops_acquire_job_lock", {
      p_job_name: jobName,
      p_lease_seconds: leaseSeconds,
      p_locked_by: lockedBy,
    });
    return result ? { acquired: true } : { acquired: false, reason: "contention" };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("Failed to acquire lock (RPC error):", errMsg);
    return { acquired: false, reason: "rpc_error", error: errMsg };
  }
}

async function opsReleaseLockBestEffort(supa: SupabaseRest, jobName: string): Promise<void> {
  try {
    await supa.rpc("ops_release_job_lock", { p_job_name: jobName });
  } catch {
    // Best effort - don't throw
  }
}

async function opsRunStart(
  supa: SupabaseRest,
  input: { job_name: string; status: "running"; metadata?: Record<string, unknown> }
): Promise<{ id: string; metadata: Record<string, unknown> }> {
  const [row] = await supa.post<Array<{ id: string; metadata: Record<string, unknown> }>>(
    `/rest/v1/ops_job_runs`,
    [{ job_name: input.job_name, status: "running", metadata: input.metadata ?? {} }],
    "return=representation"
  );
  return { id: row.id, metadata: row.metadata ?? {} };
}

async function opsRunFinishBestEffort(
  supa: SupabaseRest,
  runId: string,
  input: {
    status: "completed" | "failed";
    rows_written: number;
    error_message: string | null;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await supa.patch(
      `/rest/v1/ops_job_runs?id=eq.${encodeURIComponent(runId)}`,
      {
        finished_at: toIso(nowUtc()),
        status: input.status,
        rows_written: input.rows_written,
        error_message: input.error_message,
        metadata: input.metadata,
      },
      "return=minimal"
    );
  } catch {
    // Best effort
  }
}

async function opsLogAttemptBestEffort(supa: SupabaseRest, row: Record<string, unknown>): Promise<void> {
  try {
    await supa.post(`/rest/v1/ops_ingest_attempts`, [row], "return=minimal");
  } catch {
    // Never break ingestion
  }
}

type Severity = 1 | 2 | 3;

interface IssueInput {
  severity_level: Severity;
  issue_type: string;
  source_system: string;
  canonical_symbol: string;
  summary: string;
  description: string;
  timeframe?: string | null;
  component?: string | null;
  metadata?: Record<string, unknown>;
  related_job_run_id?: string | null;
}

async function opsUpsertIssueBestEffort(
  supa: SupabaseRest,
  enabled: boolean,
  input: IssueInput
): Promise<void> {
  if (!enabled) return;
  
  try {
    await supa.rpc("ops_upsert_issue_open", {
      p_severity_level: input.severity_level,
      p_issue_type: input.issue_type,
      p_source_system: input.source_system,
      p_canonical_symbol: input.canonical_symbol ?? "__SYSTEM__",
      p_timeframe: input.timeframe ?? null,
      p_component: input.component ?? null,
      p_summary: input.summary,
      p_description: input.description,
      p_metadata: input.metadata ?? {},
      p_related_job_run_id: input.related_job_run_id ?? null,
      p_detected_at: new Date().toISOString(),
    });
  } catch {
    // Never break primary workflows
  }
}

// ============================================================================
// HTTP RETRY WITH EXPONENTIAL BACKOFF
// ============================================================================

function parseRetryAfterSeconds(h: string | null): number | null {
  if (!h) return null;
  const n = Number(h);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function fetchJsonWithRetry(opts: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  retries?: number;
  baseBackoffSec?: number;
  capBackoffSec?: number;
}): Promise<FetchRetryResult> {
  const {
    url,
    headers,
    timeoutMs,
    maxBytes,
    retries = 6,
    baseBackoffSec = 2,
    capBackoffSec = 60,
  } = opts;

  let lastStatus: number | null = null;
  let backoffTotalSec = 0;

  for (let attempt = 0; attempt < retries; attempt++) {
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const r = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);

      const latencyMs = Date.now() - t0;
      lastStatus = r.status;

      // Rate limited - backoff and retry
      if (r.status === 429) {
        const ra = parseRetryAfterSeconds(r.headers.get("Retry-After"));
        const sleepSec =
          ra !== null
            ? clamp(ra, 0, capBackoffSec)
            : clamp(baseBackoffSec * Math.pow(2, attempt), 0, capBackoffSec);
        const sleepMs = Math.floor(sleepSec * 1000) + jitter(250);
        backoffTotalSec += sleepMs / 1000;
        await sleep(sleepMs);
        continue;
      }

      // Server errors - backoff and retry
      if (r.status >= 500 && r.status <= 504) {
        const sleepSec = clamp(baseBackoffSec * Math.pow(2, attempt), 0, capBackoffSec);
        const sleepMs = Math.floor(sleepSec * 1000) + jitter(250);
        backoffTotalSec += sleepMs / 1000;
        await sleep(sleepMs);
        continue;
      }

      // Client errors (4xx except 429) - don't retry
      if (!r.ok) {
        return {
          ok: false,
          status: r.status,
          latencyMs,
          err: (await r.text()).slice(0, 800),
          attempts: attempt + 1,
          backoffTotalSec,
        };
      }

      // Size guard via Content-Length header
      const cl = r.headers.get("content-length");
      if (cl) {
        const n = Number(cl);
        if (Number.isFinite(n) && n > maxBytes) {
          return {
            ok: false,
            status: 413,
            latencyMs,
            err: "Response too large",
            attempts: attempt + 1,
            backoffTotalSec,
          };
        }
      }

      // Read and validate body size
      const buf = await r.arrayBuffer();
      if (buf.byteLength > maxBytes) {
        return {
          ok: false,
          status: 413,
          latencyMs,
          err: "Response too large",
          attempts: attempt + 1,
          backoffTotalSec,
        };
      }

      // Parse JSON
      const text = new TextDecoder().decode(buf);
      try {
        const j = JSON.parse(text);
        return { ok: true, status: 200, json: j, latencyMs, attempts: attempt + 1, backoffTotalSec };
      } catch {
        // JSON parse failure - retry if attempts remain
        if (attempt < retries - 1) {
          const sleepSec = clamp(baseBackoffSec * Math.pow(2, attempt), 0, capBackoffSec);
          const sleepMs = Math.floor(sleepSec * 1000) + jitter(250);
          backoffTotalSec += sleepMs / 1000;
          await sleep(sleepMs);
          continue;
        }
        return {
          ok: false,
          status: 200,
          latencyMs,
          err: "HTTP 200 but JSON decode failed",
          attempts: attempt + 1,
          backoffTotalSec,
        };
      }
    } catch (e: unknown) {
      clearTimeout(timer);
      const latencyMs = Date.now() - t0;

      const sleepSec = clamp(baseBackoffSec * Math.pow(2, attempt), 0, capBackoffSec);
      const sleepMs = Math.floor(sleepSec * 1000) + jitter(250);
      backoffTotalSec += sleepMs / 1000;
      await sleep(sleepMs);

      if (attempt === retries - 1) {
        const err = e as Error;
        return {
          ok: false,
          status: "ERR",
          latencyMs,
          err: `${err?.name || "Error"}: ${err?.message || String(e)}`,
          attempts: attempt + 1,
          backoffTotalSec,
        };
      }
      lastStatus = lastStatus ?? 0;
    }
  }

  return {
    ok: false,
    status: lastStatus ?? 429,
    latencyMs: 0,
    err: "rate-limited after retries",
    attempts: retries,
    backoffTotalSec,
  };
}

// ============================================================================
// INGESTION LOGIC
// ============================================================================

function expectedTfForClass(ingestClass: string | null): "1m" | "5m" | null {
  if (ingestClass === "A") return "1m";
  if (ingestClass === "B") return "5m";
  return null;
}

function classifyHttp(status: number | "ERR" | null): "critical-auth" | "hard" | "transient" | "soft" {
  if (status === 401) return "critical-auth";
  if (status === "ERR") return "transient";
  if (status === null) return "soft";
  if ([400, 403, 404].includes(status)) return "hard";
  if (status === 429 || status >= 500) return "transient";
  return "soft";
}

/**
 * Converts provider epoch timestamp to Date.
 * Handles both seconds (10 digits) and milliseconds (13 digits) formats.
 * Massive typically uses milliseconds, but this handles edge cases gracefully.
 */
function providerEpochToDate(t: unknown): Date | null {
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  // If seconds (10 digits), convert to milliseconds
  const ms = t < 1_000_000_000_000 ? t * 1000 : t;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildAggsRangeUrl(
  endpoint: EndpointRow,
  providerTicker: string,
  mult: number,
  unit: "minute",
  fromDate: string,
  toDate: string,
  mergedParams: Json
): string {
  const base = endpoint.base_url.replace(/\/+$/, "");
  
  // DEBUG: Log before and after each replacement
  //console.log("=== buildAggsRangeUrl DEBUG ===");
  //console.log("Input template:", endpoint.path_template);
  //console.log("Input values:", { providerTicker, mult, unit, fromDate, toDate });
  
  let path = endpoint.path_template;
  //console.log("Step 0 - Original:", path);
  
  path = path.replace("{ticker}", encodeURIComponent(providerTicker));
  //console.log("Step 1 - After {ticker}:", path);
  
  path = path.replace("{multiplier}", String(mult));
  //console.log("Step 2 - After {multiplier}:", path);
  
  path = path.replace("{mult}", String(mult));
  //console.log("Step 3 - After {mult}:", path);
  
  path = path.replace("{timespan}", unit);
  //console.log("Step 4 - After {timespan}:", path);
  
  path = path.replace("{unit}", unit);
  //console.log("Step 5 - After {unit}:", path);
  
  path = path.replace("{from}", fromDate);
  //console.log("Step 6 - After {from}:", path);
  
  path = path.replace("{to}", toDate);
  //console.log("Step 7 - After {to}:", path);
  //console.log("=== END DEBUG ===");

  // Defensive: ensure all placeholders were replaced
  const unreplaced = path.match(/\{[a-zA-Z_]+\}/g);
  if (unreplaced) {
    throw new Error(`URL template placeholders not replaced: ${unreplaced.join(", ")} in path: ${path}`);
  }

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(mergedParams || {})) {
    if (v === null || v === undefined) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return `${base}${path}${qs ? `?${qs}` : ""}`;
}

async function enforceFetchCooldownBestEffort(
  supa: SupabaseRest,
  cooldownSeconds: number
): Promise<boolean> {
  if (cooldownSeconds <= 0) return true;
  try {
    const rows = await supa.get<Array<{ id: number; last_check: string }>>(
      `/rest/v1/ops_health_status?select=id,last_check&limit=1`
    );
    const row = rows?.[0];
    if (!row?.last_check) return true;

    const last = new Date(row.last_check).getTime();
    const now = Date.now();
    if (now - last < cooldownSeconds * 1000) return false;

    await supa.patch(`/rest/v1/ops_health_status?id=eq.1`, { last_check: toIso(nowUtc()) }, "return=minimal");
    return true;
  } catch {
    return true;
  }
}

async function runIngestAB(env: Env, trigger: "cron" | "manual"): Promise<void> {
  // Initialize logger with configurable level and progress interval
  const logLevelStr = strEnv(env.LOG_LEVEL, "INFO").toUpperCase();
  const logLevel: LogLevel = ["DEBUG", "INFO", "WARN", "ERROR"].includes(logLevelStr) 
    ? (logLevelStr as LogLevel) 
    : "INFO";
  const progressInterval = numEnv(env.PROGRESS_INTERVAL, 10);
  log = new Logger(logLevel, progressInterval);
  
  log.phaseStart("INIT", { trigger, timestamp: toIso(nowUtc()) });
  
  const supa = SupabaseRest.fromEnv(env);
  log.debug("DB_CONNECT", "Supabase client initialized");

  const jobName = strEnv(env.JOB_NAME, "ingest_ab");
  const maxAssets = numEnv(env.MAX_ASSETS_PER_RUN, 200);
  const timeoutMs = numEnv(env.REQUEST_TIMEOUT_MS, 30000);
  const leaseSeconds = numEnv(env.LOCK_LEASE_SECONDS, 150);
  const hardDisableStreak = numEnv(env.HARD_DISABLE_STREAK, 2);
  const maxRunBudgetMs = env.MAX_RUN_BUDGET_MS ? numEnv(env.MAX_RUN_BUDGET_MS, 0) : null;
  const maxBytes = numEnv(env.MAX_RESPONSE_BYTES, 10 * 1024 * 1024);
  const issuesOn = boolEnv(env.ENABLE_ISSUES, true);

  log.info("CONFIG", "Configuration loaded", {
    jobName,
    maxAssets,
    timeoutMs,
    leaseSeconds,
    hardDisableStreak,
    maxRunBudgetMs,
    maxBytes,
    issuesOn,
    logLevel,
    progressInterval,
  });

  const activeField = strEnv(env.ASSET_ACTIVE_FIELD, "active");
  if (activeField !== "active" && activeField !== "test_active") {
    log.error("CONFIG_INVALID", `Invalid ASSET_ACTIVE_FIELD: ${activeField}`);
    await opsUpsertIssueBestEffort(supa, issuesOn, {
      severity_level: 1,
      issue_type: "CONFIG_INVALID",
      source_system: "ingestion",
      canonical_symbol: "__SYSTEM__",
      component: "ingestion",
      summary: "Invalid ASSET_ACTIVE_FIELD",
      description: `ASSET_ACTIVE_FIELD must be 'active' or 'test_active', got '${activeField}'`,
      metadata: { activeField },
    });
    throw new Error(`Invalid ASSET_ACTIVE_FIELD=${activeField}`);
  }
  log.debug("CONFIG_VALIDATE", `ASSET_ACTIVE_FIELD validated: ${activeField}`);

  // Manual trigger cooldown
  if (trigger === "manual") {
    log.info("COOLDOWN_CHECK", "Checking manual trigger cooldown");
    const cooldown = numEnv(env.FETCH_COOLDOWN_SECONDS, 30);
    const ok = await enforceFetchCooldownBestEffort(supa, cooldown);
    if (!ok) {
      log.warn("COOLDOWN_BLOCKED", `Cooldown not elapsed (${cooldown}s), skipping`);
      return;
    }
    log.info("COOLDOWN_OK", "Cooldown check passed");
  }

  // Acquire distributed lock
  log.info("LOCK_ACQUIRE", `Attempting to acquire lock: ${jobName}`, { leaseSeconds });
  const lockResult = await opsAcquireLock(supa, jobName, leaseSeconds, "cloudflare_worker");
  if (!lockResult.acquired) {
    if (lockResult.reason === "rpc_error") {
      log.error("LOCK_RPC_ERROR", `Lock RPC failed: ${lockResult.error}`);
      await opsUpsertIssueBestEffort(supa, issuesOn, {
        severity_level: 2,
        issue_type: "LOCK_RPC_FAILED",
        source_system: "ingestion",
        canonical_symbol: "__SYSTEM__",
        component: "supabase",
        summary: "Lock acquisition RPC failed",
        description: `Could not acquire lock due to RPC error: ${lockResult.error}`,
        metadata: { job_name: jobName, error: lockResult.error },
      });
      throw new Error(`Lock acquisition RPC failed: ${lockResult.error}`);
    } else {
      log.info("LOCK_CONTENTION", "Lock held by another instance, exiting gracefully");
      return;
    }
  }
  log.info("LOCK_ACQUIRED", `Lock acquired successfully for ${jobName}`);

  const runStartMs = Date.now();

  // Start job run record
  log.setPhase("JOB_START");
  log.info("JOB_RUN_CREATE", "Creating job run record");
  const run = await opsRunStart(supa, {
    job_name: jobName,
    status: "running",
    metadata: {
      started_by: trigger,
      max_assets: maxAssets,
      timeout_ms: timeoutMs,
      lease_seconds: leaseSeconds,
      asset_active_field: activeField,
      max_response_bytes: maxBytes,
      log_url_mode: strEnv(env.LOG_URL_MODE, "sanitized"),
      allowed_provider_hosts: strEnv(env.ALLOWED_PROVIDER_HOSTS, "api.massive.com"),
    },
  });

  const runId = run.id;
  log.setRunId(runId);
  log.info("JOB_RUN_CREATED", `Job run created`, { runId });

  const counts: RunCounts = {
    assets_total: 0,
    assets_attempted: 0,
    assets_succeeded: 0,
    assets_failed: 0,
    assets_skipped: 0,
    assets_disabled: 0,
    http_429: 0,
    rows_written: 0,
    duration_ms: 0,
    skip_reasons: {},
  };

  const bumpSkip = (reason: string): void => {
    counts.assets_skipped++;
    counts.skip_reasons[reason] = (counts.skip_reasons[reason] || 0) + 1;
  };

  try {
    log.setPhase("LOAD_DATA");
    const gatingFilter = activeField === "active" ? "active=eq.true" : "test_active=eq.true";

    // Load active assets (Class A/B, non-contract only)
    log.info("LOAD_ASSETS", `Loading assets with filter: ${gatingFilter}`);
    const assets = await supa.get<AssetRow[]>(
      `/rest/v1/core_asset_registry_all` +
        `?select=canonical_symbol,provider_ticker,asset_class,source,endpoint_key,query_params,active,test_active,ingest_class,base_timeframe,is_sparse,is_contract,expected_update_seconds` +
        `&${gatingFilter}` +
        `&is_contract=eq.false&ingest_class=in.(A,B)` +
        `&order=canonical_symbol.asc&limit=${maxAssets}`
    );
    counts.assets_total = assets.length;
    log.info("ASSETS_LOADED", `Loaded ${assets.length} assets for ingestion`);

    // Load active endpoints (filtered by source=massive)
    log.info("LOAD_ENDPOINTS", "Loading Massive endpoints");
    const endpoints = await supa.get<EndpointRow[]>(
      `/rest/v1/core_endpoint_registry?select=endpoint_key,source,base_url,path_template,default_params,auth_mode,active` +
        `&active=eq.true&source=eq.massive`
    );
    const endpointsByKey = new Map(endpoints.map((e) => [e.endpoint_key, e] as const));
    log.info("ENDPOINTS_LOADED", `Loaded ${endpoints.length} active Massive endpoints`, {
      endpointKeys: Array.from(endpointsByKey.keys()),
    });

    log.phaseEnd("LOAD_DATA", { assets: assets.length, endpoints: endpoints.length });

    // Process each asset
    log.setPhase("PROCESS");
    log.info("LOOP_START", `Starting asset processing loop`, { total: assets.length });
    
    let assetIndex = 0;
    for (const asset of assets) {
      assetIndex++;
      
      // Check run budget
      if (maxRunBudgetMs && Date.now() - runStartMs > maxRunBudgetMs) {
        log.warn("BUDGET_EXCEEDED", `Run budget exceeded (${maxRunBudgetMs}ms), stopping early`, {
          processed: assetIndex - 1,
          remaining: assets.length - assetIndex + 1,
        });
        break;
      }

      const canonical = asset.canonical_symbol;
      log.assetStart(canonical, assetIndex, assets.length, {
        ingestClass: asset.ingest_class,
        timeframe: asset.base_timeframe,
        endpointKey: asset.endpoint_key,
      });

      // Skip contracts or Class C (should not appear due to query filter, but defensive)
      if (asset.is_contract || asset.ingest_class === "C") {
        bumpSkip("contract_or_class_c");
        log.assetSkip("contract_or_class_c", { is_contract: asset.is_contract, ingest_class: asset.ingest_class });
        await opsLogAttemptBestEffort(supa, {
          run_id: runId,
          canonical_symbol: canonical,
          provider_ticker: asset.provider_ticker,
          asset_class: asset.asset_class,
          endpoint_key: asset.endpoint_key,
          timeframe: asset.base_timeframe ?? "",
          error_text: "Out of scope (contract or class C)",
          meta: { skip_reason: "contract_or_class_c" },
        });
        await sleep(200 + jitter(300));
        continue;
      }

      // Validate provider ticker
      if (!asset.provider_ticker) {
        bumpSkip("missing_provider_ticker");
        log.assetSkip("missing_provider_ticker");
        await opsLogAttemptBestEffort(supa, {
          run_id: runId,
          canonical_symbol: canonical,
          endpoint_key: asset.endpoint_key,
          timeframe: asset.base_timeframe ?? "",
          error_text: "provider_ticker is NULL",
          meta: { skip_reason: "missing_provider_ticker" },
        });
        await sleep(200 + jitter(300));
        continue;
      }

      // Validate timeframe matches ingest class
      const expectedTf = expectedTfForClass(asset.ingest_class);
      const tf = (expectedTf || asset.base_timeframe || "1m") as "1m" | "5m";

      if (!expectedTf || tf !== expectedTf) {
        bumpSkip("class_tf_mismatch");
        log.assetSkip("class_tf_mismatch", { expected: expectedTf, got: tf, ingestClass: asset.ingest_class });
        await opsLogAttemptBestEffort(supa, {
          run_id: runId,
          canonical_symbol: canonical,
          provider_ticker: asset.provider_ticker,
          endpoint_key: asset.endpoint_key,
          timeframe: tf,
          error_text: "class/timeframe mismatch",
          meta: { skip_reason: "class_tf_mismatch", expected: expectedTf, got: tf },
        });
        await sleep(200 + jitter(300));
        continue;
      }


      // Get endpoint configuration
      log.debug("ENDPOINT_LOOKUP", `Looking up endpoint: ${asset.endpoint_key}`);
      const endpoint = endpointsByKey.get(asset.endpoint_key);
      if (!endpoint) {
        bumpSkip("missing_endpoint_config");
        log.assetSkip("missing_endpoint_config", { endpoint_key: asset.endpoint_key });
        await opsLogAttemptBestEffort(supa, {
          run_id: runId,
          canonical_symbol: canonical,
          provider_ticker: asset.provider_ticker,
          asset_class: asset.asset_class,
          endpoint_key: asset.endpoint_key,
          timeframe: tf,
          error_text: `Missing endpoint_key=${asset.endpoint_key}`,
          meta: { skip_reason: "missing_endpoint_config" },
        });
        await sleep(200 + jitter(300));
        continue;
      }

      // Security: validate endpoint host is allowlisted
      if (!isHostAllowlisted(env, endpoint.base_url)) {
        bumpSkip("endpoint_not_allowlisted");
        log.assetSkip("endpoint_not_allowlisted (SECURITY)", { 
          endpoint_key: endpoint.endpoint_key, 
          base_url: sanitizeUrlForLogging(endpoint.base_url) 
        });
        await opsLogAttemptBestEffort(supa, {
          run_id: runId,
          canonical_symbol: canonical,
          endpoint_key: asset.endpoint_key,
          timeframe: tf,
          error_text: "Endpoint base_url not allowlisted",
          meta: { skip_reason: "endpoint_not_allowlisted" },
        });
        await opsUpsertIssueBestEffort(supa, issuesOn, {
          severity_level: 1,
          issue_type: "ENDPOINT_ALLOWLIST_VIOLATION",
          source_system: "ingestion",
          canonical_symbol: "__SYSTEM__",
          component: "security",
          summary: "Endpoint allowlist violation",
          description: "Endpoint base_url host is not allowlisted; refusing to send provider credentials.",
          metadata: { 
            endpoint_key: endpoint.endpoint_key, 
            base_url: sanitizeUrlForLogging(endpoint.base_url) 
          },
          related_job_run_id: runId,
        });
        await sleep(200 + jitter(300));
        continue;
      }

      counts.assets_attempted++;
      log.debug("VALIDATION_PASSED", "Asset passed all validation checks", { tf, endpoint_key: asset.endpoint_key });

      // Ensure ingest state row exists
      log.debug("STATE_ENSURE", "Ensuring ingest state row exists");
      await supa.post(
        `/rest/v1/data_ingest_state?on_conflict=canonical_symbol,timeframe`,
        [{ canonical_symbol: canonical, timeframe: tf, status: "ok", updated_at: toIso(nowUtc()) }],
        "resolution=merge-duplicates,return=minimal"
      );

      // Load current state
      log.debug("STATE_LOAD", "Loading current ingest state");
      const stateRows = await supa.get<IngestStateRow[]>(
        `/rest/v1/data_ingest_state?select=canonical_symbol,timeframe,last_bar_ts_utc,last_run_at_utc,status,last_error,updated_at,hard_fail_streak,last_attempted_to_utc,last_successful_to_utc` +
          `&canonical_symbol=eq.${encodeURIComponent(canonical)}` +
          `&timeframe=eq.${encodeURIComponent(tf)}` +
          `&limit=1`
      );
      const state = stateRows[0];
      log.debug("STATE_LOADED", "Current state retrieved", {
        lastBarTs: state?.last_bar_ts_utc,
        status: state?.status,
        hardFailStreak: state?.hard_fail_streak,
      });

      // Mark as running
      await supa.patch(
        `/rest/v1/data_ingest_state?canonical_symbol=eq.${encodeURIComponent(canonical)}&timeframe=eq.${encodeURIComponent(tf)}`,
        { status: "running", last_run_at_utc: toIso(nowUtc()), updated_at: toIso(nowUtc()) },
        "return=minimal"
      );

      // Calculate time window
      log.debug("WINDOW_CALC", "Calculating fetch time window");
      const tfSec = tfToSeconds(tf);
      const safetyLagSec = tf === "1m" ? 120 : 480;
      const overlapBars = tf === "1m" ? 5 : 2;
      const backfillDays = 7;

      const safeTo = floorToBoundary(new Date(Date.now() - safetyLagSec * 1000), tfSec);

      let fromTs: Date;
      if (!state?.last_bar_ts_utc) {
        // No prior data - backfill from backfillDays ago
        fromTs = floorToBoundary(new Date(safeTo.getTime() - backfillDays * 86400 * 1000), tfSec);
        log.info("WINDOW_BACKFILL", `No prior cursor, backfilling ${backfillDays} days`, {
          from: toIso(fromTs),
          to: toIso(safeTo),
        });
      } else {
        // Resume from last bar with overlap
        const cursor = new Date(state.last_bar_ts_utc);
        const overlapStart = new Date(cursor.getTime() - overlapBars * tfSec * 1000);
        const backfillFloor = new Date(safeTo.getTime() - backfillDays * 86400 * 1000);
        fromTs = floorToBoundary(new Date(Math.max(overlapStart.getTime(), backfillFloor.getTime())), tfSec);
        log.info("WINDOW_RESUME", `Resuming from cursor with ${overlapBars} bar overlap`, {
          cursor: state.last_bar_ts_utc,
          from: toIso(fromTs),
          to: toIso(safeTo),
        });
      }

      // Record attempted window
      try {
        await supa.patch(
          `/rest/v1/data_ingest_state?canonical_symbol=eq.${encodeURIComponent(canonical)}&timeframe=eq.${encodeURIComponent(tf)}`,
          { last_attempted_to_utc: toIso(safeTo), updated_at: toIso(nowUtc()) },
          "return=minimal"
        );
      } catch {
        // Best effort
      }

      // No-op if window is empty
      if (fromTs.getTime() >= safeTo.getTime()) {
        log.info("WINDOW_NOOP", "No new data to fetch (already up to date)");
        counts.assets_succeeded++;

        await opsLogAttemptBestEffort(supa, {
          run_id: runId,
          canonical_symbol: canonical,
          provider_ticker: asset.provider_ticker,
          asset_class: asset.asset_class,
          endpoint_key: asset.endpoint_key,
          timeframe: tf,
          req_from_utc: toIso(fromTs),
          req_to_utc: toIso(safeTo),
          http_status: 200,
          latency_ms: 0,
          result_count: 0,
          inserted_count: 0,
          deduped_count: 0,
          error_text: null,
          meta: { note: "noop_window" },
        });

        await supa.patch(
          `/rest/v1/data_ingest_state?canonical_symbol=eq.${encodeURIComponent(canonical)}&timeframe=eq.${encodeURIComponent(tf)}`,
          {
            status: "ok",
            last_error: null,
            last_successful_to_utc: toIso(safeTo),
            updated_at: toIso(nowUtc()),
          },
          "return=minimal"
        );

        log.assetSuccess({ note: "noop_window" });
        await sleep(200 + jitter(300));
        continue;
      }

      // Build request URL
      const mult = tf === "1m" ? 1 : 5;
      const fromDate = alignIsoToDateYYYYMMDD(toIso(fromTs));
      const toDate = alignIsoToDateYYYYMMDD(toIso(safeTo));

      const mergedParams: Json = { ...(endpoint.default_params || {}), ...(asset.query_params || {}) };
      if (!("limit" in mergedParams)) mergedParams["limit"] = 50000;

      // DEBUG: Log template before URL building
      log.debug("TEMPLATE_DEBUG", "Path template inspection", {
        raw_template: endpoint.path_template,
        template_length: endpoint.path_template.length,
        has_multiplier: endpoint.path_template.includes("{multiplier}"),
        has_timespan: endpoint.path_template.includes("{timespan}"),
        has_ticker: endpoint.path_template.includes("{ticker}"),
        mult_value: mult,
        unit_value: "minute",
        ticker_value: asset.provider_ticker,
      });

      const url = buildAggsRangeUrl(endpoint, asset.provider_ticker, mult, "minute", fromDate, toDate, mergedParams);
      const urlLog = await urlForLogs(env, url);
      
      log.debug("URL_BUILT", "Final URL constructed", {
        url: url,
        url_length: url.length,
        has_encoded_braces: url.includes("%7B") || url.includes("%7D"),
      });
      
      log.info("HTTP_REQUEST", `Fetching bars from provider`, {
        from: fromDate,
        to: toDate,
        mult,
        providerTicker: asset.provider_ticker,
      });

      // Make request with retry
      const headers = { Authorization: `Bearer ${env.MASSIVE_KEY}` };
      const fetchStartMs = Date.now();
      const resp = await fetchJsonWithRetry({
        url,
        headers,
        timeoutMs,
        maxBytes,
      });
      
      log.info("HTTP_RESPONSE", `Provider response received`, {
        ok: resp.ok,
        status: resp.status,
        latencyMs: resp.latencyMs,
        attempts: resp.attempts,
        backoffTotalSec: resp.backoffTotalSec,
      });

      if (resp.status === 429) counts.http_429++;

      // Check for provider-level errors in response body
      const respJson = resp.json as Record<string, unknown> | undefined;
      const providerBodyError =
        resp.ok && (respJson?.status === "ERROR" || respJson?.error || respJson?.message);

      if (!resp.ok || providerBodyError) {
        // Auth failure is systemic - abort entire run
        if (resp.status === 401) {
          log.error("AUTH_FAILURE", "Provider auth failure (401) - STOPPING ENTIRE RUN");
          await opsUpsertIssueBestEffort(supa, issuesOn, {
            severity_level: 1,
            issue_type: "PROVIDER_AUTH_FAILURE",
            source_system: "ingestion",
            canonical_symbol: "__SYSTEM__",
            component: "massive",
            summary: "Provider auth failure (401)",
            description: "Massive returned 401 Unauthorized. Systemic failure - stopping run.",
            metadata: { run_id: runId, endpoint_key: asset.endpoint_key, example_asset: canonical, url: urlLog },
            related_job_run_id: runId,
          });
          throw new Error("Provider auth failure (401) – stopping run");
        }

        const errText = providerBodyError
          ? String(respJson?.error || respJson?.message || "Provider error in body")
          : String(resp.err || "Unknown error");

        const kind = classifyHttp(resp.ok ? 200 : resp.status);
        const isHard = kind === "hard";
        const prevStreak = Number(state?.hard_fail_streak || 0);
        const nextStreak = isHard ? prevStreak + 1 : prevStreak;

        log.assetFail(errText, {
          status: resp.status,
          kind,
          isHard,
          hardFailStreak: nextStreak,
          threshold: hardDisableStreak,
        });

        counts.assets_failed++;

        await opsLogAttemptBestEffort(supa, {
          run_id: runId,
          canonical_symbol: canonical,
          provider_ticker: asset.provider_ticker,
          asset_class: asset.asset_class,
          endpoint_key: asset.endpoint_key,
          timeframe: tf,
          req_from_utc: toIso(fromTs),
          req_to_utc: toIso(safeTo),
          http_status: typeof resp.status === "number" ? resp.status : null,
          latency_ms: resp.latencyMs,
          result_count: null,
          inserted_count: 0,
          deduped_count: 0,
          error_text: errText,
          meta: {
            url: urlLog,
            attempts: resp.attempts,
            backoff_total_sec: resp.backoffTotalSec,
            kind,
            hard_fail_streak: nextStreak,
          },
        });

        // Log issue for failed fetch
        await opsUpsertIssueBestEffort(supa, issuesOn, {
          severity_level: isHard ? 2 : 3,
          issue_type: "ASSET_FETCH_FAILED",
          source_system: "ingestion",
          canonical_symbol: canonical,
          timeframe: tf,
          component: "massive",
          summary: `Fetch failed (${isHard ? "hard" : "transient"})`,
          description: errText,
          metadata: { run_id: runId, http_status: resp.status, url: urlLog, hard_fail_streak: nextStreak, kind },
          related_job_run_id: runId,
        });

        // Update state with error and streak
        try {
          await supa.patch(
            `/rest/v1/data_ingest_state?canonical_symbol=eq.${encodeURIComponent(canonical)}&timeframe=eq.${encodeURIComponent(tf)}`,
            { status: "error", last_error: errText, hard_fail_streak: nextStreak, updated_at: toIso(nowUtc()) },
            "return=minimal"
          );
        } catch {
          await supa.patch(
            `/rest/v1/data_ingest_state?canonical_symbol=eq.${encodeURIComponent(canonical)}&timeframe=eq.${encodeURIComponent(tf)}`,
            { status: "error", last_error: errText, updated_at: toIso(nowUtc()) },
            "return=minimal"
          );
        }

        // Auto-disable after consecutive hard failures
        if (isHard && nextStreak >= hardDisableStreak) {
          counts.assets_disabled++;
          log.warn("AUTO_DISABLE", `Disabling asset after ${nextStreak} consecutive hard failures`);

          const disablePatch =
            activeField === "test_active"
              ? { test_active: false, updated_at: toIso(nowUtc()) }
              : { active: false, updated_at: toIso(nowUtc()) };

          await supa.patch(
            `/rest/v1/core_asset_registry_all?canonical_symbol=eq.${encodeURIComponent(canonical)}`,
            disablePatch,
            "return=minimal"
          );

          await supa.patch(
            `/rest/v1/data_ingest_state?canonical_symbol=eq.${encodeURIComponent(canonical)}&timeframe=eq.${encodeURIComponent(tf)}`,
            { status: "disabled", updated_at: toIso(nowUtc()) },
            "return=minimal"
          );

          await opsUpsertIssueBestEffort(supa, issuesOn, {
            severity_level: 1,
            issue_type: "ASSET_DISABLED",
            source_system: "ingestion",
            canonical_symbol: canonical,
            timeframe: tf,
            component: "ingestion",
            summary: "Asset auto-disabled",
            description: `Disabled after ${nextStreak} consecutive hard failures.`,
            metadata: { 
              run_id: runId, 
              http_status: resp.status, 
              last_error: errText, 
              url: urlLog, 
              streak: nextStreak, 
              gating_field: activeField 
            },
            related_job_run_id: runId,
          });
        }

        await sleep(200 + jitter(500));
        continue;
      }

      // Parse and validate results
      const resultsAny = respJson?.results;
      const results: Array<Record<string, unknown>> = Array.isArray(resultsAny) ? resultsAny : [];

      if (!Array.isArray(resultsAny)) {
        await opsLogAttemptBestEffort(supa, {
          run_id: runId,
          canonical_symbol: canonical,
          endpoint_key: asset.endpoint_key,
          timeframe: tf,
          meta: { warning: "unexpected_response_shape", url: urlLog, got: typeof resultsAny },
        });
      }

      // Filter results to [fromTs, safeTo) window
      log.debug("FILTER_BARS", `Filtering ${results.length} bars to time window`);
      const filtered = results
        .map((r) => ({
          ts: providerEpochToDate(r.t),
          raw: r,
        }))
        .filter((x): x is { ts: Date; raw: Record<string, unknown> } =>
          x.ts instanceof Date && !Number.isNaN(x.ts.getTime())
        )
        .filter((x) => {
          const t = x.ts.getTime();
          return t >= fromTs.getTime() && t < safeTo.getTime();
        })
        .sort((a, b) => a.ts.getTime() - b.ts.getTime());
      
      log.info("BARS_FILTERED", `Filtered to ${filtered.length} bars in window`, {
        rawCount: results.length,
        filteredCount: filtered.length,
        droppedCount: results.length - filtered.length,
      });

      // Transform to bar rows
      const barRows = filtered.map((x) => {
        const r = x.raw;
        return {
          canonical_symbol: canonical,
          provider_ticker: asset.provider_ticker,
          timeframe: tf,
          ts_utc: toIso(x.ts),
          open: r.o ?? null,
          high: r.h ?? null,
          low: r.l ?? null,
          close: r.c ?? null,
          vol: r.v ?? null,
          vwap: r.vw ?? null,
          trade_count: r.n ?? null,
          is_partial: false,
          source: "massive",
          ingested_at: toIso(nowUtc()),
          raw: r ?? {},
        };
      });

      // Chunked upsert to avoid request size limits
      const CHUNK_SIZE = 5000;
      let inserted = 0;

      if (barRows.length > 0) {
        log.info("DB_UPSERT", `Upserting ${barRows.length} bars to database`, {
          chunks: Math.ceil(barRows.length / CHUNK_SIZE),
          chunkSize: CHUNK_SIZE,
        });
        
        try {
          for (let i = 0; i < barRows.length; i += CHUNK_SIZE) {
            const chunk = barRows.slice(i, i + CHUNK_SIZE);
            const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
            const totalChunks = Math.ceil(barRows.length / CHUNK_SIZE);
            
            log.debug("CHUNK_UPSERT", `Upserting chunk ${chunkNum}/${totalChunks}`, { size: chunk.length });
            
            await supa.post(
              `/rest/v1/data_bars?on_conflict=canonical_symbol,timeframe,ts_utc`,
              chunk,
              "resolution=merge-duplicates,return=minimal"
            );
            inserted += chunk.length;
          }
          counts.rows_written += inserted;
          log.info("DB_UPSERT_OK", `Successfully upserted ${inserted} bars`);
        } catch (e) {
          counts.assets_failed++;
          const errMsg = e instanceof Error ? e.message : String(e);
          log.assetFail(`Bar insert failed: ${errMsg}`);

          await opsLogAttemptBestEffort(supa, {
            run_id: runId,
            canonical_symbol: canonical,
            provider_ticker: asset.provider_ticker,
            asset_class: asset.asset_class,
            endpoint_key: asset.endpoint_key,
            timeframe: tf,
            req_from_utc: toIso(fromTs),
            req_to_utc: toIso(safeTo),
            http_status: 200,
            latency_ms: resp.latencyMs,
            result_count: results.length,
            inserted_count: 0,
            deduped_count: 0,
            error_text: "BAR_INSERT_FAILED",
            meta: { url: urlLog },
          });

          await sleep(200 + jitter(500));
          continue;
        }
      } else {
        log.info("NO_NEW_BARS", "No bars to upsert (all filtered out or empty response)");
      }

      // Update cursor to newest bar (only if we fetched any bars)
      const newCursor = barRows.length > 0 ? barRows[barRows.length - 1].ts_utc : state?.last_bar_ts_utc;
      log.debug("CURSOR_UPDATE", `Cursor: ${state?.last_bar_ts_utc} -> ${newCursor}`);

      counts.assets_succeeded++;

      await opsLogAttemptBestEffort(supa, {
        run_id: runId,
        canonical_symbol: canonical,
        provider_ticker: asset.provider_ticker,
        asset_class: asset.asset_class,
        endpoint_key: asset.endpoint_key,
        timeframe: tf,
        req_from_utc: toIso(fromTs),
        req_to_utc: toIso(safeTo),
        http_status: 200,
        latency_ms: resp.latencyMs,
        result_count: results.length,
        inserted_count: inserted,  // Actually "rows_sent" - can't distinguish insert vs update with merge-duplicates
        deduped_count: null,       // Unknown with resolution=merge-duplicates
        error_text: null,
        meta: {
          url: urlLog,
          attempts: resp.attempts,
          backoff_total_sec: resp.backoffTotalSec,
          filtered_count: barRows.length,
        },
      });

      // Update state with success and reset streak
      try {
        await supa.patch(
          `/rest/v1/data_ingest_state?canonical_symbol=eq.${encodeURIComponent(canonical)}&timeframe=eq.${encodeURIComponent(tf)}`,
          {
            last_bar_ts_utc: newCursor,
            last_successful_to_utc: toIso(safeTo),
            status: "ok",
            last_error: null,
            hard_fail_streak: 0,
            updated_at: toIso(nowUtc()),
          },
          "return=minimal"
        );
      } catch {
        await supa.patch(
          `/rest/v1/data_ingest_state?canonical_symbol=eq.${encodeURIComponent(canonical)}&timeframe=eq.${encodeURIComponent(tf)}`,
          {
            last_bar_ts_utc: newCursor,
            last_successful_to_utc: toIso(safeTo),
            status: "ok",
            last_error: null,
            updated_at: toIso(nowUtc()),
          },
          "return=minimal"
        );
      }

      log.assetSuccess({ bars: barRows.length, newCursor });
      await sleep(200 + jitter(300));
    }

    // Job completed successfully
    counts.duration_ms = Date.now() - runStartMs;
    log.setPhase("COMPLETE");
    log.setAsset(null);
    
    log.phaseStart("SUMMARY");
    log.info("STATS", "=== FINAL STATISTICS ===", {
      duration_ms: counts.duration_ms,
      duration_sec: Math.round(counts.duration_ms / 1000),
    });
    log.info("ASSETS", `Assets: ${counts.assets_succeeded}/${counts.assets_total} succeeded`, {
      total: counts.assets_total,
      attempted: counts.assets_attempted,
      succeeded: counts.assets_succeeded,
      failed: counts.assets_failed,
      skipped: counts.assets_skipped,
      disabled: counts.assets_disabled,
    });
    log.info("DATA", `Data: ${counts.rows_written} rows written`, {
      rows_written: counts.rows_written,
      http_429_count: counts.http_429,
    });
    log.logTimingSummary();  // Log per-asset timing statistics
    if (Object.keys(counts.skip_reasons).length > 0) {
      log.info("SKIP_REASONS", "Skip breakdown", counts.skip_reasons);
    }
    log.phaseEnd("SUMMARY");

    await opsRunFinishBestEffort(supa, runId, {
      status: "completed",
      rows_written: counts.rows_written,
      error_message: null,
      metadata: { ...run.metadata, ...counts },
    });
    
    log.info("JOB_COMPLETE", `✓ Ingestion job completed successfully`);
  } catch (e: unknown) {
    counts.duration_ms = Date.now() - runStartMs;
    const err = e as Error;

    log.setPhase("ERROR");
    log.error("JOB_FAILED", `✗ Ingestion job FAILED: ${err.message}`, {
      error: err.message,
      duration_ms: counts.duration_ms,
      counts,
    });

    await opsRunFinishBestEffort(supa, runId, {
      status: "failed",
      rows_written: counts.rows_written,
      error_message: err?.message || String(e),
      metadata: { ...run.metadata, ...counts },
    });

    await opsUpsertIssueBestEffort(supa, issuesOn, {
      severity_level: 1,
      issue_type: "JOB_FAILED",
      source_system: "ingestion",
      canonical_symbol: "__SYSTEM__",
      component: "ingestion",
      summary: `Job failed: ${jobName}`,
      description: err?.message || String(e),
      metadata: { run_id: runId, counts },
      related_job_run_id: runId,
    });

    throw e;
  } finally {
    log.info("LOCK_RELEASE", `Releasing lock: ${jobName}`);
    await opsReleaseLockBestEffort(supa, jobName);
    log.info("CLEANUP", "Job cleanup complete");
  }
}

// ============================================================================
// CLOUDFLARE WORKER HANDLERS
// ============================================================================

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runIngestAB(env, "cron"));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Auth check first - no DB calls before authorization
    const authorized = await isAuthorizedInternal(req, env);
    if (!authorized) {
      return new Response("Not Found", { status: 404 });
    }

    const url = new URL(req.url);

    // Health endpoint
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          job_name: env.JOB_NAME || "ingest_ab",
          asset_active_field: env.ASSET_ACTIVE_FIELD || "active",
          max_assets_per_run: env.MAX_ASSETS_PER_RUN || "200",
          log_url_mode: env.LOG_URL_MODE || "sanitized",
          max_response_bytes: env.MAX_RESPONSE_BYTES || String(10 * 1024 * 1024),
          allowed_provider_hosts: env.ALLOWED_PROVIDER_HOSTS || "api.massive.com",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Manual trigger endpoint
    if (url.pathname === "/trigger" || url.pathname === "/") {
      ctx.waitUntil(runIngestAB(env, "manual"));
      return new Response("ok\n", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },
};