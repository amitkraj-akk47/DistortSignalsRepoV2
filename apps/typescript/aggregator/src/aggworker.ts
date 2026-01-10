import { createClient } from "@supabase/supabase-js";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  ENV_NAME?: string;
  JOB_NAME?: string;
  TRIGGER?: string;

  MAX_TASKS_PER_RUN?: string;
  MAX_WINDOWS_PER_TASK?: string;
  RUNNING_STALE_SECONDS?: string;
  AUTO_DISABLE_HARD_FAILS?: string;
  AGG_DERIVATION_VERSION?: string;
}

function isTransientError(e: any): boolean {
  const msg = String(e?.message ?? e ?? "");
  const code = String(e?.code ?? "");
  return (
    msg.includes("timeout") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("429") ||
    code === "PGRST301" ||
    code === "PGRST302"
  );
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const startTime = Date.now();
    console.log(`[AGGREGATOR] Cron triggered at ${new Date().toISOString()}`);
    
    ctx.waitUntil(
      runAggregation(env).then(() => {
        const duration = Date.now() - startTime;
        console.log(`[AGGREGATOR] Completed in ${duration}ms`);
      }).catch((e) => {
        const duration = Date.now() - startTime;
        console.error(`[AGGREGATOR] Failed after ${duration}ms:`, e);
      })
    );
  },
};

async function runAggregation(env: Env): Promise<void> {
  const envName = (env.ENV_NAME ?? "DEV").toUpperCase();
  const jobName = env.JOB_NAME ?? "agg-master";
  const trigger = env.TRIGGER ?? "cron";

  const maxTasks = Number(env.MAX_TASKS_PER_RUN ?? "20");
  const maxWindows = Number(env.MAX_WINDOWS_PER_TASK ?? "100");
  const runningStaleSeconds = Number(env.RUNNING_STALE_SECONDS ?? "900");
  const autoDisableHardFails = Number(env.AUTO_DISABLE_HARD_FAILS ?? "3");
  const derivationVersion = Number(env.AGG_DERIVATION_VERSION ?? "1");

  console.log(`[AGG] Starting: env=${envName} job=${jobName} maxTasks=${maxTasks}`);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const runId = crypto.randomUUID();
  console.log(`[AGG] Run ID: ${runId}`);

  await supabase.rpc("ops_runlog_start", {
    p_run_id: runId,
    p_job_name: jobName,
    p_trigger: trigger,
    p_env_name: envName,
  });

  await supabase.rpc("ops_runlog_checkpoint", {
    p_run_id: runId,
    p_checkpoint: "cron_start",
    p_details: { ts: new Date().toISOString() },
  });

  const { data: tasks, error: tasksErr } = await supabase.rpc("agg_get_due_tasks", {
    p_env_name: envName,
    p_now_utc: new Date().toISOString(),
    p_limit: maxTasks,
    p_running_stale_seconds: runningStaleSeconds,
  });

  if (tasksErr) {
    console.error(`[AGG] Failed to get tasks:`, tasksErr);
    await supabase.rpc("ops_runlog_finish", {
      p_run_id: runId,
      p_status: "failed",
      p_stats: { error: String(tasksErr.message ?? tasksErr) },
    });
    return;
  }

  console.log(`[AGG] Found ${tasks?.length ?? 0} due tasks`);

  await supabase.rpc("ops_runlog_checkpoint", {
    p_run_id: runId,
    p_checkpoint: "selected_due_tasks",
    p_details: { task_count: tasks?.length ?? 0 },
  });

  let totalCreated = 0;
  let totalPoor = 0;

  for (const t of tasks ?? []) {
    const symbol = t.canonical_symbol as string;
    const toTf = t.timeframe as string;

    const { data: startRes, error: startErr } = await supabase.rpc("agg_start", {
      p_symbol: symbol,
      p_tf: toTf,
      p_now_utc: new Date().toISOString(),
    });

    if (startErr || !startRes?.success) continue;

    let cursorIso: string | null = startRes.last_agg_bar_ts_utc ?? null;

    try {
      if (!cursorIso) {
        const { data: cur, error: curErr } = await supabase.rpc("agg_bootstrap_cursor", {
          p_symbol: symbol,
          p_to_tf: toTf,
          p_now_utc: new Date().toISOString(),
        });
        if (curErr) throw curErr;
        cursorIso = String(cur);
      }

      const { data: catchRes, error: catchErr } = await supabase.rpc("catchup_aggregation_range", {
        p_symbol: symbol,
        p_to_tf: toTf,
        p_start_cursor_utc: cursorIso,
        p_max_windows: maxWindows,
        p_now_utc: new Date().toISOString(),
        p_derivation_version: derivationVersion,
        p_ignore_confirmation: false,
      });
      if (catchErr) throw catchErr;

      const barsCreated = Number(catchRes?.bars_created ?? 0);
      const barsPoor = Number(catchRes?.bars_quality_poor ?? 0);
      const newCursor = String(catchRes?.cursor_advanced_to ?? cursorIso);

      totalCreated += barsCreated;
      totalPoor += barsPoor;

      await supabase.rpc("agg_finish", {
        p_symbol: symbol,
        p_tf: toTf,
        p_success: true,
        p_new_cursor_utc: newCursor,
        p_stats: {
          windows_processed: Number(catchRes?.windows_processed ?? 0),
          bars_created: barsCreated,
          bars_quality_poor: barsPoor,
          bars_skipped: Number(catchRes?.bars_skipped ?? 0),
        },
        p_now_utc: new Date().toISOString(),
        p_auto_disable_hard_fail_threshold: autoDisableHardFails,
      });
    } catch (e: any) {
      const transient = isTransientError(e);
      await supabase.rpc("agg_finish", {
        p_symbol: symbol,
        p_tf: toTf,
        p_success: false,
        p_fail_kind: transient ? "transient" : "hard",
        p_error: String(e?.message ?? e),
        p_stats: { error: String(e?.message ?? e) },
        p_now_utc: new Date().toISOString(),
        p_auto_disable_hard_fail_threshold: autoDisableHardFails,
      });
    }
  }

  await supabase.rpc("ops_runlog_prune", { p_job_name: jobName, p_trigger: trigger, p_keep: 10 });

  await supabase.rpc("ops_runlog_finish", {
    p_run_id: runId,
    p_status: "success",
    p_stats: { bars_created: totalCreated, bars_quality_poor: totalPoor, tasks: tasks?.length ?? 0 },
  });

  console.log(`[AGG] Completed: ${totalCreated} bars created, ${totalPoor} poor quality, ${tasks?.length ?? 0} tasks processed`);
}
