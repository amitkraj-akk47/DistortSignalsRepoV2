/**
 * DistortSignals Market Data Ingestion Worker
 * 
 * Production-ready Cloudflare Worker for ingesting market data from Massive
 * Supports Class A (1-minute) and Class B (5-minute) assets.
 * 
 * REFACTORED: Uses RPC functions to minimize subrequests:
 * - ingest_asset_start(): Replaces POST + GET + PATCH (3 → 1)
 * - upsert_bars_batch(): Replaces chunked POSTs (N → 1)
 * - ingest_asset_finish(): Replaces state update PATCHes (1-2 → 1)
 * 
 * @version 2.0.0
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

// RPC response types
interface IngestStartState {
  canonical_symbol: string;
  timeframe: string;
  last_bar_ts_utc: string | null;
  last_run_at_utc: string | null;
  status: string;
  last_error: string | null;
  hard_fail_streak: number;
  last_attempted_to_utc: string | null;
  last_successful_to_utc: string | null;
  updated_at: string;
}

interface UpsertBarsResult {
  success: boolean;
  input_count: number;
  upserted_total: number;
  inserted: number;
  updated: number;
  rejected: number;
  rejected_samples?: Array<{ idx: number; reason: string; canonical_symbol?: string }>;
  ts_range?: { start: string; end: string } | null;
  error?: string;
  error_detail?: string;
}

interface IngestFinishResult {
  canonical_symbol: string;
  timeframe: string;
  status: string;
  last_bar_ts_utc?: string;
  last_error?: string;
  hard_fail_streak: number;
  success: boolean;
  was_disabled: boolean;
  previous_streak: number;
  new_streak: number;
  fail_kind?: string;
}

interface DxyDerivedResult {
  success: boolean;
  inserted?: number;
  updated?: number;
  skipped_incomplete?: number;
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
  rows_inserted: number;
  rows_updated: number;
  rows_rejected: number;
  duration_ms: number;
  skip_reasons: Record<string, number>;
  subrequests: number;  // Track subrequest count
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

/**
 * Structured logger for clear, traceable output.
 */
class Logger {
  private runId: string | null = null;
  private currentAsset: string | null = null;
  private currentPhase: string = "INIT";
  private assetIndex: number = 0;
  private assetTotal: number = 0;
  private minLevel: LogLevel;
  private progressInterval: number;
  
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

  phaseStart(phase: string, details?: Record<string, unknown>): void {
    this.setPhase(phase);
    this.info("START", `=== ${phase} ===`, details);
  }

  phaseEnd(phase: string, details?: Record<string, unknown>): void {
    this.info("END", `=== ${phase} complete ===`, details);
  }

  assetStart(symbol: string, index: number, total: number, details?: Record<string, unknown>): void {
    this.setAsset(symbol, index, total);
    this.assetStartTime = Date.now();
    
    if (this.shouldLog("DEBUG")) {
      this.debug("ASSET_START", `Processing asset`, details);
    } else if (index === 1 || index % this.progressInterval === 0 || index === total) {
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
    
    if (this.shouldLog("DEBUG")) {
      this.debug("ASSET_OK", `Asset completed successfully`, { ...details, durationMs });
    } else if (this.assetIndex === 1 || this.assetIndex % this.progressInterval === 0 || this.assetIndex === this.assetTotal) {
      this.info("ASSET_OK", `Asset completed`, { ...details, durationMs });
    }
  }

  assetFail(reason: string, details?: Record<string, unknown>): void {
    const durationMs = Date.now() - this.assetStartTime;
    this.assetTimings.push(durationMs);
    this.error("ASSET_FAIL", `Asset failed: ${reason}`, { ...details, durationMs });
  }

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
  const raw = (env.ALLOWED_PROVIDER_HOSTS || "api.polygon.io")
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
    // Best effort
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

      if (r.status >= 500 && r.status <= 504) {
        const sleepSec = clamp(baseBackoffSec * Math.pow(2, attempt), 0, capBackoffSec);
        const sleepMs = Math.floor(sleepSec * 1000) + jitter(250);
        backoffTotalSec += sleepMs / 1000;
        await sleep(sleepMs);
        continue;
      }

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

      const text = new TextDecoder().decode(buf);
      try {
        const j = JSON.parse(text);
        return { ok: true, status: 200, json: j, latencyMs, attempts: attempt + 1, backoffTotalSec };
      } catch {
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

/**
 * Maps HTTP status to failure kind for streak logic.
 * Only 'hard' failures increment the streak counter.
 */
function classifyHttpToFailKind(status: number | "ERR" | null): "hard" | "transient" | "soft" {
  if (status === 401) return "hard";  // Auth failure - systemic
  if (status === "ERR") return "transient";
  if (status === null) return "soft";
  if ([400, 403, 404].includes(status)) return "hard";
  if (status === 429 || status >= 500) return "transient";
  return "soft";
}

function providerEpochToDate(t: unknown): Date | null {
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
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
  
  let path = endpoint.path_template;
  path = path.replace("{ticker}", encodeURIComponent(providerTicker));
  path = path.replace("{multiplier}", String(mult));
  path = path.replace("{mult}", String(mult));
  path = path.replace("{timespan}", unit);
  path = path.replace("{unit}", unit);
  path = path.replace("{from}", fromDate);
  path = path.replace("{to}", toDate);

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

// ============================================================================
// MAIN INGESTION FUNCTION (REFACTORED WITH RPCs)
// ============================================================================

async function runIngestAB(env: Env, trigger: "cron" | "manual"): Promise<void> {
  // Initialize logger
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
      allowed_provider_hosts: strEnv(env.ALLOWED_PROVIDER_HOSTS, "api.polygon.io"),
      version: "2.0.0-rpc",
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
    rows_inserted: 0,
    rows_updated: 0,
    rows_rejected: 0,
    duration_ms: 0,
    skip_reasons: {},
    subrequests: 0,
  };

  const bumpSkip = (reason: string): void => {
    counts.assets_skipped++;
    counts.skip_reasons[reason] = (counts.skip_reasons[reason] || 0) + 1;
  };

  // Track subrequests
  const trackSubrequest = (n = 1): void => {
    counts.subrequests += n;
  };

  // Track FX pairs for DXY derivation
  const FX_PAIRS_FOR_DXY = new Set(['EURUSD', 'USDJPY', 'GBPUSD', 'USDCAD', 'USDSEK', 'USDCHF']);
  const fxWindowsIngested: Map<string, Set<string>> = new Map(); // window_key -> Set<symbol>
  let dxyDerivedCount = 0;
  let dxyFailedCount = 0;

  const makeWindowKey = (from: Date, to: Date): string => {
    return `${toIso(from)}|${toIso(to)}`;
  };

  try {
    log.setPhase("LOAD_DATA");
    const gatingFilter = activeField === "active" ? "active=eq.true" : "test_active=eq.true";

    // Load active assets
    log.info("LOAD_ASSETS", `Loading assets with filter: ${gatingFilter}`);
    const assets = await supa.get<AssetRow[]>(
      `/rest/v1/core_asset_registry_all` +
        `?select=canonical_symbol,provider_ticker,asset_class,source,endpoint_key,query_params,active,test_active,ingest_class,base_timeframe,is_sparse,is_contract,expected_update_seconds` +
        `&${gatingFilter}` +
        `&is_contract=eq.false&ingest_class=in.(A,B)` +
        `&order=canonical_symbol.asc&limit=${maxAssets}`
    );
    trackSubrequest();
    counts.assets_total = assets.length;
    log.info("ASSETS_LOADED", `Loaded ${assets.length} assets for ingestion`);

    // Load active endpoints
    log.info("LOAD_ENDPOINTS", "Loading Massive endpoints");
    const endpoints = await supa.get<EndpointRow[]>(
      `/rest/v1/core_endpoint_registry?select=endpoint_key,source,base_url,path_template,default_params,auth_mode,active` +
        `&active=eq.true&source=eq.massive`
    );
    trackSubrequest();
    const endpointsByKey = new Map(endpoints.map((e) => [e.endpoint_key, e] as const));
    log.info("ENDPOINTS_LOADED", `Loaded ${endpoints.length} active Massive endpoints`, {
      endpointKeys: Array.from(endpointsByKey.keys()),
    });

    // Load pause_fetch flags for all assets at once (instead of per-asset checks)
    log.debug("LOAD_PAUSE_FLAGS", "Loading pause_fetch flags for assets");
    const pauseFetchStates = await supa.get<Array<{ canonical_symbol: string; timeframe: string; pause_fetch: boolean }>>(
      `/rest/v1/data_ingest_state?select=canonical_symbol,timeframe,pause_fetch`
    );
    trackSubrequest();
    const pauseFetchMap = new Map<string, Set<string>>();
    const pausedRecords: Array<{ symbol: string; tf: string }> = [];
    
    for (const state of pauseFetchStates) {
      const key = state.canonical_symbol;
      if (state.pause_fetch) {
        if (!pauseFetchMap.has(key)) {
          pauseFetchMap.set(key, new Set());
        }
        pauseFetchMap.get(key)!.add(state.timeframe);
        pausedRecords.push({ symbol: key, tf: state.timeframe });
      }
    }
    
    log.info("PAUSE_FLAGS_LOADED", `Loaded pause flags - ${pausedRecords.length} assets paused`, {
      paused_count: pausedRecords.length,
      paused_assets: pausedRecords.map(r => `${r.symbol}/${r.tf}`),
      total_state_records: pauseFetchStates.length
    });
    
    if (pausedRecords.length > 0) {
      log.debug("PAUSED_ASSETS_DETAIL", "Assets with pause_fetch=true", {
        paused: pausedRecords
      });
    }

    log.phaseEnd("LOAD_DATA", { assets: assets.length, endpoints: endpoints.length, subrequests: counts.subrequests });

    // ========================================================================
    // ORPHAN RECORD DETECTION & MARKING (disabled to reduce subrequests)
    // ========================================================================
    log.setPhase("ORPHAN_CLEANUP");
    log.info("ORPHAN_SKIP", "Orphan cleanup disabled to reduce rate limiting - run manually if needed");
    
    log.phaseEnd("ORPHAN_CLEANUP", { subrequests: counts.subrequests });

    // ========================================================================
    // ASSET PROCESSING LOOP (REFACTORED WITH RPCs)
    // ========================================================================
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
          subrequests: counts.subrequests,
        });
        break;
      }

      const canonical = asset.canonical_symbol;
      log.assetStart(canonical, assetIndex, assets.length, {
        ingestClass: asset.ingest_class,
        timeframe: asset.base_timeframe,
        endpointKey: asset.endpoint_key,
      });

      // ====== PRE-VALIDATION (no subrequests) ======
      
      if (asset.is_contract || asset.ingest_class === "C") {
        bumpSkip("contract_or_class_c");
        log.assetSkip("contract_or_class_c", { is_contract: asset.is_contract, ingest_class: asset.ingest_class });
        await sleep(100 + jitter(100));
        continue;
      }

      if (!asset.provider_ticker) {
        bumpSkip("missing_provider_ticker");
        log.assetSkip("missing_provider_ticker");
        await sleep(100 + jitter(100));
        continue;
      }

      const expectedTf = expectedTfForClass(asset.ingest_class);
      const tf = (expectedTf || asset.base_timeframe || "1m") as "1m" | "5m";

      if (!expectedTf || tf !== expectedTf) {
        bumpSkip("class_tf_mismatch");
        log.assetSkip("class_tf_mismatch", { expected: expectedTf, got: tf, ingestClass: asset.ingest_class });
        await sleep(100 + jitter(100));
        continue;
      }

      const endpoint = endpointsByKey.get(asset.endpoint_key);
      if (!endpoint) {
        bumpSkip("missing_endpoint_config");
        log.assetSkip("missing_endpoint_config", { endpoint_key: asset.endpoint_key });
        await sleep(100 + jitter(100));
        continue;
      }

      if (!isHostAllowlisted(env, endpoint.base_url)) {
        bumpSkip("endpoint_not_allowlisted");
        log.assetSkip("endpoint_not_allowlisted (SECURITY)", { 
          endpoint_key: endpoint.endpoint_key, 
          base_url: sanitizeUrlForLogging(endpoint.base_url) 
        });
        await opsUpsertIssueBestEffort(supa, issuesOn, {
          severity_level: 1,
          issue_type: "ENDPOINT_ALLOWLIST_VIOLATION",
          source_system: "ingestion",
          canonical_symbol: "__SYSTEM__",
          component: "security",
          summary: "Endpoint allowlist violation",
          description: "Endpoint base_url host is not allowlisted; refusing to send provider credentials.",
          metadata: { endpoint_key: endpoint.endpoint_key, base_url: sanitizeUrlForLogging(endpoint.base_url) },
          related_job_run_id: runId,
        });
        trackSubrequest();
        await sleep(100 + jitter(100));
        continue;
      }

      counts.assets_attempted++;

      // ====== STEP 0.5: SAFEGUARD - Check for orphaned state records ======
      // Prevents loading state for assets that have been disabled but still have stale records
      // If found, marks them as orphaned and skips processing
      try {
        const stateCheck = await supa.get<Array<{ canonical_symbol: string; timeframe: string }>>(
          `/rest/v1/data_ingest_state?canonical_symbol=eq.${encodeURIComponent(canonical)}&timeframe=eq.${encodeURIComponent(tf)}&select=canonical_symbol,timeframe`
        );
        trackSubrequest();
        
        if (stateCheck.length > 0) {
          // Verify this asset is actually in the active registry
          const registryCheck = await supa.get<Array<{ canonical_symbol: string }>>(
            `/rest/v1/core_asset_registry_all?canonical_symbol=eq.${encodeURIComponent(canonical)}&select=canonical_symbol`
          );
          trackSubrequest();
          
          // State exists but asset no longer in registry (orphaned)
          if (registryCheck.length === 0) {
            log.warn("ORPHANED_STATE", `Orphaned state record detected for ${canonical} (${tf}), marking and skipping`, {
              reason: "asset_disabled_but_state_exists"
            });
            
            // Mark the record as orphaned with a note
            try {
              await supa.patch(
                `/rest/v1/data_ingest_state?canonical_symbol=eq.${encodeURIComponent(canonical)}&timeframe=eq.${encodeURIComponent(tf)}`,
                {
                  status: "orphaned",
                  notes: `ORPHAN RECORD: Asset disabled on ${toIso(nowUtc())} but state record was not cleaned up. This record should be deleted.`
                },
                "return=minimal"
              );
              trackSubrequest();
            } catch {
              // Best effort marking
            }
            
            bumpSkip("orphaned_state_record");
            await sleep(100 + jitter(100));
            continue;
          }
        }
      } catch (e) {
        // If safeguard check fails, log warning but continue (don't break the run)
        const errMsg = e instanceof Error ? e.message : String(e);
        log.debug("SAFEGUARD_CHECK_FAILED", `Orphaned state check failed: ${errMsg}`);
        // Continue with normal processing
      }

      // ====== STEP 1: Check pause_fetch flag ======
      // If pause_fetch is true, skip API data fetching for this asset
      const isPaused = pauseFetchMap.has(canonical) && pauseFetchMap.get(canonical)!.has(tf);
      
      if (isPaused) {
        log.info("PAUSED", `Asset ${canonical} (${tf}) has pause_fetch=true - SKIPPING ALL PROCESSING`);
        log.debug("PAUSE_DETAILS", `Pause flag check result`, {
          symbol: canonical,
          timeframe: tf,
          pause_fetch: true,
          action: "skip_asset"
        });
        bumpSkip("paused_by_flag");
        await sleep(100 + jitter(100));
        continue;  // Skip to next asset - NO API calls, NO database writes
      }
      
      log.debug("PAUSE_CHECK", `Pause check passed (not paused)`, {
        symbol: canonical,
        timeframe: tf,
        pause_fetch: false
      });

      // ====== STEP 2: ingest_asset_start RPC (replaces POST + GET + PATCH) ======
      log.debug("RPC_START", "Calling ingest_asset_start");
      let state: IngestStartState;
      try {
        state = await supa.rpc<IngestStartState>("ingest_asset_start", {
          p_symbol: canonical,
          p_tf: tf,
        });
        trackSubrequest();
        log.debug("RPC_START_OK", "State loaded and marked running", {
          lastBarTs: state.last_bar_ts_utc,
          hardFailStreak: state.hard_fail_streak,
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        log.assetFail(`ingest_asset_start RPC failed: ${errMsg}`);
        counts.assets_failed++;
        await sleep(100 + jitter(100));
        continue;
      }

      // ====== STEP 3: Calculate time window ======
      const tfSec = tfToSeconds(tf);
      const safetyLagSec = tf === "1m" ? 120 : 480;
      const overlapBars = tf === "1m" ? 5 : 2;
      const backfillDays = state.last_bar_ts_utc ? 1 : 7;  // Only 7 days on first run

      const safeTo = floorToBoundary(new Date(Date.now() - safetyLagSec * 1000), tfSec);

      let fromTs: Date;
      if (!state.last_bar_ts_utc) {
        fromTs = floorToBoundary(new Date(safeTo.getTime() - backfillDays * 86400 * 1000), tfSec);
        log.info("WINDOW_BACKFILL", `No prior cursor, backfilling ${backfillDays} days`, {
          from: toIso(fromTs),
          to: toIso(safeTo),
        });
      } else {
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

      // No-op if window is empty
      if (fromTs.getTime() >= safeTo.getTime()) {
        log.info("WINDOW_NOOP", "No new data to fetch (already up to date)");
        
        // Mark success with ingest_asset_finish
        try {
          await supa.rpc<IngestFinishResult>("ingest_asset_finish", {
            p_symbol: canonical,
            p_tf: tf,
            p_success: true,
            p_successful_to: toIso(safeTo),
          });
          trackSubrequest();
        } catch {
          // Best effort
        }
        
        counts.assets_succeeded++;
        log.assetSuccess({ note: "noop_window" });
        await sleep(100 + jitter(100));
        continue;
      }

      // ====== STEP 4: Fetch from provider ======
      const mult = tf === "1m" ? 1 : 5;
      const fromDate = alignIsoToDateYYYYMMDD(toIso(fromTs));
      const toDate = alignIsoToDateYYYYMMDD(toIso(safeTo));

      const mergedParams: Json = { ...(endpoint.default_params || {}), ...(asset.query_params || {}) };
      if (!("limit" in mergedParams)) mergedParams["limit"] = 50000;

      const url = buildAggsRangeUrl(endpoint, asset.provider_ticker, mult, "minute", fromDate, toDate, mergedParams);
      const urlLog = await urlForLogs(env, url);
      
      log.info("HTTP_REQUEST", `Fetching bars from provider`, {
        from: fromDate,
        to: toDate,
        mult,
        providerTicker: asset.provider_ticker,
      });

      const headers = { Authorization: `Bearer ${env.MASSIVE_KEY}` };
      
      log.info("API_FETCH_START", `🔄 MAKING API CALL to Massive - Asset is NOT paused`, {
        symbol: canonical,
        timeframe: tf,
        from: fromDate,
        to: toDate,
        endpoint: asset.endpoint_key
      });
      
      const resp = await fetchJsonWithRetry({
        url,
        headers,
        timeoutMs,
        maxBytes,
      });
      // Provider fetch counts as 1 subrequest (external)
      
      log.info("HTTP_RESPONSE", `Provider response received`, {
        ok: resp.ok,
        status: resp.status,
        latencyMs: resp.latencyMs,
        attempts: resp.attempts,
      });

      if (resp.status === 429) counts.http_429++;

      // ====== STEP 5: Handle provider errors ======
      const respJson = resp.json as Record<string, unknown> | undefined;
      const providerBodyError = resp.ok && (respJson?.status === "ERROR" || respJson?.error || respJson?.message);

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
          trackSubrequest();
          throw new Error("Provider auth failure (401) – stopping run");
        }

        const errText = providerBodyError
          ? String(respJson?.error || respJson?.message || "Provider error in body")
          : String(resp.err || "Unknown error");

        const failKind = classifyHttpToFailKind(resp.ok ? 200 : resp.status);

        log.assetFail(errText, {
          status: resp.status,
          failKind,
          hardFailStreak: state.hard_fail_streak,
        });

        // Call ingest_asset_finish with failure
        try {
          const finishResult = await supa.rpc<IngestFinishResult>("ingest_asset_finish", {
            p_symbol: canonical,
            p_tf: tf,
            p_success: false,
            p_fail_kind: failKind,
            p_error: errText,
            p_attempted_to: toIso(safeTo),
            p_hard_disable_threshold: hardDisableStreak,
          });
          trackSubrequest();
          
          if (finishResult.was_disabled) {
            counts.assets_disabled++;
            log.warn("AUTO_DISABLE", `Asset auto-disabled after ${finishResult.new_streak} hard failures`);
            
            // Also update the registry
            const disablePatch = activeField === "test_active"
              ? { test_active: false, updated_at: toIso(nowUtc()) }
              : { active: false, updated_at: toIso(nowUtc()) };
            await supa.patch(
              `/rest/v1/core_asset_registry_all?canonical_symbol=eq.${encodeURIComponent(canonical)}`,
              disablePatch,
              "return=minimal"
            );
            trackSubrequest();
            
            await opsUpsertIssueBestEffort(supa, issuesOn, {
              severity_level: 1,
              issue_type: "ASSET_DISABLED",
              source_system: "ingestion",
              canonical_symbol: canonical,
              timeframe: tf,
              component: "ingestion",
              summary: "Asset auto-disabled",
              description: `Disabled after ${finishResult.new_streak} consecutive hard failures.`,
              metadata: { run_id: runId, http_status: resp.status, last_error: errText, streak: finishResult.new_streak },
              related_job_run_id: runId,
            });
            trackSubrequest();
          }
        } catch {
          // Best effort
        }

        counts.assets_failed++;
        await sleep(100 + jitter(200));
        continue;
      }

      // ====== STEP 6: Parse and filter bars ======
      const resultsAny = respJson?.results;
      const results: Array<Record<string, unknown>> = Array.isArray(resultsAny) ? resultsAny : [];

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

      // Transform to bar rows for RPC
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

      // ====== STEP 7: upsert_bars_batch RPC (replaces chunked POSTs) ======
      let upsertResult: UpsertBarsResult | null = null;
      
      if (barRows.length > 0) {
        log.info("RPC_UPSERT", `Upserting ${barRows.length} bars via RPC`);
        
        try {
          upsertResult = await supa.rpc<UpsertBarsResult>("upsert_bars_batch", {
            p_bars: barRows,
          });
          trackSubrequest();
          
          if (!upsertResult.success) {
            throw new Error(upsertResult.error || "upsert_bars_batch returned success=false");
          }
          
          counts.rows_written += upsertResult.upserted_total;
          counts.rows_inserted += upsertResult.inserted;
          counts.rows_updated += upsertResult.updated;
          counts.rows_rejected += upsertResult.rejected;
          
          log.info("RPC_UPSERT_OK", `Upserted ${upsertResult.upserted_total} bars`, {
            inserted: upsertResult.inserted,
            updated: upsertResult.updated,
            rejected: upsertResult.rejected,
            tsRange: upsertResult.ts_range,
          });
          
          if (upsertResult.rejected > 0 && upsertResult.rejected_samples) {
            log.warn("BARS_REJECTED", `${upsertResult.rejected} bars rejected by validation`, {
              samples: upsertResult.rejected_samples.slice(0, 3),
            });
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          log.assetFail(`upsert_bars_batch RPC failed: ${errMsg}`);
          
          // Mark failure
          try {
            await supa.rpc<IngestFinishResult>("ingest_asset_finish", {
              p_symbol: canonical,
              p_tf: tf,
              p_success: false,
              p_fail_kind: "transient",
              p_error: `Bar upsert failed: ${errMsg}`,
              p_attempted_to: toIso(safeTo),
            });
            trackSubrequest();
          } catch {
            // Best effort
          }
          
          counts.assets_failed++;
          await sleep(100 + jitter(200));
          continue;
        }
      } else {
        log.info("NO_NEW_BARS", "No bars to upsert (all filtered out or empty response)");
      }

      // ====== STEP 8: ingest_asset_finish RPC (success) ======
      const newCursor = barRows.length > 0 ? barRows[barRows.length - 1].ts_utc : state.last_bar_ts_utc;
      
      try {
        await supa.rpc<IngestFinishResult>("ingest_asset_finish", {
          p_symbol: canonical,
          p_tf: tf,
          p_success: true,
          p_new_cursor: newCursor,
          p_successful_to: toIso(safeTo),
        });
        trackSubrequest();
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        log.warn("RPC_FINISH_WARN", `ingest_asset_finish failed (non-fatal): ${errMsg}`);
      }

      counts.assets_succeeded++;
      log.assetSuccess({ 
        bars: barRows.length, 
        inserted: upsertResult?.inserted ?? 0,
        updated: upsertResult?.updated ?? 0,
        newCursor,
      });

      // ====== DXY DERIVATION: Track FX ingestion ======
      if (FX_PAIRS_FOR_DXY.has(canonical) && tf === '1m' && barRows.length > 0) {
        const windowKey = makeWindowKey(fromTs, safeTo);
        
        if (!fxWindowsIngested.has(windowKey)) {
          fxWindowsIngested.set(windowKey, new Set());
        }
        fxWindowsIngested.get(windowKey)!.add(canonical);
        
        const ingestedForWindow = fxWindowsIngested.get(windowKey)!;
        log.debug("DXY_TRACK", `FX pair ingested for window`, { 
          symbol: canonical, 
          window: windowKey,
          count: ingestedForWindow.size,
          pairs: Array.from(ingestedForWindow).sort() 
        });
        
        // Check if we have all 6 FX pairs for this window
        if (ingestedForWindow.size === 6) {
          log.info("DXY_DERIVE_START", `All 6 FX pairs ready - deriving DXY`, { 
            window: windowKey,
            pairs: Array.from(ingestedForWindow).sort() 
          });
          
          try {
            const dxyResult = await supa.rpc<DxyDerivedResult>("calc_dxy_range_derived", {
              p_from_utc: toIso(fromTs),
              p_to_utc: toIso(safeTo),
              p_tf: "1m",
              p_derivation_version: 1,
            });
            trackSubrequest();
            
            if (dxyResult?.success) {
              dxyDerivedCount++;
              log.info("DXY_DERIVE_SUCCESS", `DXY derived successfully`, {
                window: windowKey,
                inserted: dxyResult.inserted || 0,
                updated: dxyResult.updated || 0,
                skipped: dxyResult.skipped_incomplete || 0,
              });
            } else {
              dxyFailedCount++;
              log.warn("DXY_DERIVE_WARN", `DXY derivation returned success=false`, { 
                window: windowKey 
              });
            }
          } catch (e: any) {
            dxyFailedCount++;
            const errMsg = e instanceof Error ? e.message : String(e);
            log.warn("DXY_DERIVE_ERROR", `DXY derivation failed (non-fatal)`, { 
              window: windowKey,
              error: errMsg 
            });
            
            // Create issue for tracking
            await opsUpsertIssueBestEffort(supa, issuesOn, {
              severity_level: 2,
              issue_type: "DXY_DERIVATION_FAILED",
              source_system: "ingestion",
              canonical_symbol: "DXY",
              component: "dxy_derivation",
              summary: `DXY derivation failed for window ${windowKey}`,
              description: errMsg,
              metadata: { window: windowKey, error: errMsg },
              related_job_run_id: runId,
            });
          }
        }
      }
      
      await sleep(100 + jitter(150));
    }

    // ========================================================================
    // JOB COMPLETION
    // ========================================================================
    counts.duration_ms = Date.now() - runStartMs;
    log.setPhase("COMPLETE");
    log.setAsset(null);
    
    log.phaseStart("SUMMARY");
    log.info("STATS", "=== FINAL STATISTICS ===", {
      duration_ms: counts.duration_ms,
      duration_sec: Math.round(counts.duration_ms / 1000),
      subrequests: counts.subrequests,
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
      rows_inserted: counts.rows_inserted,
      rows_updated: counts.rows_updated,
      rows_rejected: counts.rows_rejected,
      http_429_count: counts.http_429,
    });
    
    // DXY derivation summary
    const totalDxyWindows = Array.from(fxWindowsIngested.values()).filter(s => s.size === 6).length;
    if (totalDxyWindows > 0 || fxWindowsIngested.size > 0) {
      log.info("DXY", `DXY: ${dxyDerivedCount} derived, ${dxyFailedCount} failed, ${totalDxyWindows}/${fxWindowsIngested.size} complete windows`, {
        derived: dxyDerivedCount,
        failed: dxyFailedCount,
        complete_windows: totalDxyWindows,
        total_windows: fxWindowsIngested.size,
      });
    }
    
    log.logTimingSummary();
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
    trackSubrequest();
    
    log.info("JOB_COMPLETE", `✓ Ingestion job completed successfully`, { subrequests: counts.subrequests });
  } catch (e: unknown) {
    counts.duration_ms = Date.now() - runStartMs;
    const err = e as Error;

    log.setPhase("ERROR");
    log.error("JOB_FAILED", `✗ Ingestion job FAILED: ${err.message}`, {
      error: err.message,
      duration_ms: counts.duration_ms,
      subrequests: counts.subrequests,
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
    const authorized = await isAuthorizedInternal(req, env);
    if (!authorized) {
      return new Response("Not Found", { status: 404 });
    }

    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          version: "2.0.0-rpc",
          job_name: env.JOB_NAME || "ingest_ab",
          asset_active_field: env.ASSET_ACTIVE_FIELD || "active",
          max_assets_per_run: env.MAX_ASSETS_PER_RUN || "200",
          log_level: env.LOG_LEVEL || "INFO",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.pathname === "/trigger" || url.pathname === "/") {
      ctx.waitUntil(runIngestAB(env, "manual"));
      return new Response("ok\n", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },
};