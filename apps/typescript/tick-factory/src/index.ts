/**
 * DistortSignals – Market Data Ingestion Worker
 * Provider: Massive
 *
 * Canonical ingestion for Class A (1m) and Class B (5m) assets.
 * All timestamps stored in UTC (ISO-8601, TIMESTAMPTZ).
 */

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  MASSIVE_KEY: string;

  INTERNAL_API_KEY?: string;
  ALLOWED_PROVIDER_HOSTS?: string;

  JOB_NAME?: string;
  MAX_ASSETS_PER_RUN?: string;
  REQUEST_TIMEOUT_MS?: string;
  LOCK_LEASE_SECONDS?: string;
  ASSET_ACTIVE_FIELD?: string;
  MAX_RUN_BUDGET_MS?: string;
  HARD_DISABLE_STREAK?: string;
  FETCH_COOLDOWN_SECONDS?: string;

  ENABLE_ISSUES?: string;
}

/* ───────────────────────────────────────────── */
/* Utilities                                     */
/* ───────────────────────────────────────────── */

const nowUtc = () => new Date();
const toIso = (d: Date) => d.toISOString();

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const jitter = (ms: number) => Math.floor(Math.random() * ms);

const boolEnv = (v?: string, d = false) =>
  v ? ["1", "true", "yes", "on"].includes(v.toLowerCase()) : d;

const numEnv = (v?: string, d = 0) =>
  Number.isFinite(Number(v)) ? Number(v) : d;

const strEnv = (v?: string, d = "") => (v ?? d).trim();

const tfSeconds = (tf: "1m" | "5m") => (tf === "1m" ? 60 : 300);

function floorToTf(d: Date, sec: number): Date {
  return new Date(Math.floor(d.getTime() / (sec * 1000)) * sec * 1000);
}

/* ───────────────────────────────────────────── */
/* Provider timestamp normalization (CRITICAL)   */
/* ───────────────────────────────────────────── */

function providerEpochToUtcIso(t: unknown): string | null {
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  const ms = t < 1_000_000_000_000 ? t * 1000 : t;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString(); // ALWAYS UTC
}

/* ───────────────────────────────────────────── */
/* Supabase REST client                          */
/* ───────────────────────────────────────────── */

class SupabaseRest {
  constructor(private url: string, private key: string) {
    this.url = url.replace(/\/+$/, "");
  }

  private headers(extra?: Record<string, string>) {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      ...(extra || {}),
    };
  }

  async get<T>(path: string): Promise<T> {
    const r = await fetch(`${this.url}${path}`, { headers: this.headers() });
    if (!r.ok) throw new Error(`GET ${path} failed ${r.status}`);
    return r.json() as Promise<T>;
  }

  async post<T>(
    path: string,
    body: unknown,
    prefer = "return=minimal"
  ): Promise<T> {
    const r = await fetch(`${this.url}${path}`, {
      method: "POST",
      headers: this.headers({ Prefer: prefer }),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST ${path} failed ${r.status}`);
    return prefer.includes("return=minimal") ? ({} as T) : r.json();
  }

  async patch<T>(
    path: string,
    body: unknown,
    prefer = "return=minimal"
  ): Promise<T> {
    const r = await fetch(`${this.url}${path}`, {
      method: "PATCH",
      headers: this.headers({ Prefer: prefer }),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`PATCH ${path} failed ${r.status}`);
    return prefer.includes("return=minimal") ? ({} as T) : r.json();
  }

  async rpc<T>(fn: string, body: unknown): Promise<T> {
    const r = await fetch(`${this.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`RPC ${fn} failed ${r.status}`);
    return r.json();
  }
}

/* ───────────────────────────────────────────── */
/* Lock handling                                 */
/* ───────────────────────────────────────────── */

type LockResult =
  | { acquired: true }
  | { acquired: false; reason: "contention" | "rpc_error"; error?: string };

async function acquireLock(
  supa: SupabaseRest,
  job: string,
  lease: number
): Promise<LockResult> {
  try {
    const ok = await supa.rpc<boolean>("ops_acquire_job_lock", {
      p_job_name: job,
      p_lease_seconds: lease,
      p_locked_by: "cf-worker",
    });
    return ok ? { acquired: true } : { acquired: false, reason: "contention" };
  } catch (e) {
    return {
      acquired: false,
      reason: "rpc_error",
      error: (e as Error).message,
    };
  }
}

async function releaseLock(supa: SupabaseRest, job: string) {
  try {
    await supa.rpc("ops_release_job_lock", { p_job_name: job });
  } catch {}
}

/* ───────────────────────────────────────────── */
/* Ingestion core                                */
/* ───────────────────────────────────────────── */

async function runIngest(env: Env, trigger: "cron" | "manual") {
  const supa = new SupabaseRest(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY
  );

  const job = strEnv(env.JOB_NAME, "ingest_massive_ab");
  const maxAssets = numEnv(env.MAX_ASSETS_PER_RUN, 200);
  const lease = numEnv(env.LOCK_LEASE_SECONDS, 150);
  const timeoutMs = numEnv(env.REQUEST_TIMEOUT_MS, 30000);
  const hardDisableStreak = numEnv(env.HARD_DISABLE_STREAK, 2);
  const issuesOn = boolEnv(env.ENABLE_ISSUES, true);
  const activeField = strEnv(env.ASSET_ACTIVE_FIELD, "active");

  /* Acquire lock */
  const lock = await acquireLock(supa, job, lease);
  if (!lock.acquired) {
    if (lock.reason === "rpc_error") throw new Error(lock.error);
    return;
  }

  try {
    /* Load assets */
    const assets = await supa.get<any[]>(
      `/rest/v1/core_asset_registry_all` +
        `?${activeField}=eq.true` +
        `&ingest_class=in.(A,B)` +
        `&is_contract=eq.false` +
        `&limit=${maxAssets}`
    );

    /* Load endpoints */
    const endpoints = await supa.get<any[]>(
      `/rest/v1/core_endpoint_registry?active=eq.true&source=eq.massive`
    );
    const endpointMap = new Map(endpoints.map(e => [e.endpoint_key, e]));

    for (const asset of assets) {
      const tf: "1m" | "5m" =
        asset.ingest_class === "A" ? "1m" : "5m";

      /* Ensure state row */
      await supa.post(
        `/rest/v1/data_ingest_state?on_conflict=canonical_symbol,timeframe`,
        [{
          canonical_symbol: asset.canonical_symbol,
          timeframe: tf,
          status: "ok",
          updated_at: toIso(nowUtc()),
        }],
        "resolution=merge-duplicates"
      );

      const state = (await supa.get<any[]>(
        `/rest/v1/data_ingest_state?canonical_symbol=eq.${asset.canonical_symbol}&timeframe=eq.${tf}&limit=1`
      ))[0];

      /* Calculate window */
      const sec = tfSeconds(tf);
      const safety = tf === "1m" ? 120 : 480;
      const safeTo = floorToTf(
        new Date(Date.now() - safety * 1000),
        sec
      );

      let fromTs: Date;
      if (!state?.last_bar_ts_utc) {
        fromTs = floorToTf(
          new Date(safeTo.getTime() - 7 * 86400 * 1000),
          sec
        );
      } else {
        fromTs = floorToTf(
          new Date(new Date(state.last_bar_ts_utc).getTime() - sec * 5 * 1000),
          sec
        );
      }

      if (fromTs >= safeTo) continue;

      /* Fetch Massive */
      const endpoint = endpointMap.get(asset.endpoint_key);
      if (!endpoint) continue;

      const url =
        endpoint.base_url +
        endpoint.path_template
          .replace("{ticker}", asset.provider_ticker)
          .replace("{from}", fromTs.toISOString().slice(0, 10))
          .replace("{to}", safeTo.toISOString().slice(0, 10));

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);

      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${env.MASSIVE_KEY}` },
        signal: controller.signal,
      }).finally(() => clearTimeout(t));

      if (!r.ok) continue;

      const json = await r.json();
      const results = Array.isArray(json.results) ? json.results : [];

      const bars = results
        .map((r: any) => {
          const ts = providerEpochToUtcIso(r.t);
          if (!ts) return null;
          return {
            canonical_symbol: asset.canonical_symbol,
            provider_ticker: asset.provider_ticker,
            timeframe: tf,
            ts_utc: ts,
            open: r.o,
            high: r.h,
            low: r.l,
            close: r.c,
            vol: r.v ?? null,
            source: "massive",
            ingested_at: toIso(nowUtc()),
            raw: r,
          };
        })
        .filter(Boolean)
        .filter(
          (b: any) =>
            new Date(b.ts_utc) >= fromTs &&
            new Date(b.ts_utc) < safeTo
        );

      if (bars.length === 0) continue;

      /* Upsert */
      await supa.post(
        `/rest/v1/data_bars?on_conflict=canonical_symbol,timeframe,ts_utc`,
        bars,
        "resolution=merge-duplicates"
      );

      /* Advance cursor */
      await supa.patch(
        `/rest/v1/data_ingest_state?canonical_symbol=eq.${asset.canonical_symbol}&timeframe=eq.${tf}`,
        {
          last_bar_ts_utc: bars[bars.length - 1].ts_utc,
          last_successful_to_utc: toIso(safeTo),
          status: "ok",
          hard_fail_streak: 0,
          updated_at: toIso(nowUtc()),
        }
      );

      await sleep(200 + jitter(300));
    }
  } finally {
    await releaseLock(supa, job);
  }
}

/* ───────────────────────────────────────────── */
/* Cloudflare handlers                           */
/* ───────────────────────────────────────────── */

export default {
  async scheduled(_: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runIngest(env, "cron"));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    if (req.headers.get("x-internal-api-key") !== env.INTERNAL_API_KEY)
      return new Response("Not found", { status: 404 });

    if (new URL(req.url).pathname === "/health")
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });

    ctx.waitUntil(runIngest(env, "manual"));
    return new Response("ok");
  },
};
