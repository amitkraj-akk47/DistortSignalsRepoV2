-- =====================================================================
-- DistortSignals - Data Quality Validation System (v2.0)
-- Anchor: 000_full_script_data_validation.sql
-- Date: 2026-01-15
-- Notes:
--  - Append-only quality tables
--  - SECURITY DEFINER RPCs, service_role only
--  - START-LABELED aggregation reconciliation
--  - HARD_FAIL architecture gates
-- =====================================================================

-- ---------- Extensions ----------
create extension if not exists pgcrypto;

-- ---------- Tables ----------
create table if not exists public.quality_workerhealth (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),

  worker_name     text not null,
  run_id          uuid not null,
  trigger         text not null default 'cron',  -- cron|manual|api
  mode            text not null default 'fast',  -- fast|full

  started_at      timestamptz not null,
  finished_at     timestamptz not null,
  duration_ms     numeric(12,2) not null,

  status          text not null,                -- pass|warning|critical|HARD_FAIL|error
  checks_run      int not null default 0,
  issue_count     int not null default 0,

  checkpoints     jsonb not null default '{}'::jsonb,
  metrics         jsonb not null default '{}'::jsonb,
  error_detail    jsonb not null default '{}'::jsonb
);

create index if not exists idx_quality_workerhealth_recent
  on public.quality_workerhealth (created_at desc);

create index if not exists idx_quality_workerhealth_status_recent
  on public.quality_workerhealth (status, created_at desc);

create table if not exists public.ops_issues (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),

  source          text not null,
  run_id          uuid null,

  severity        text not null,   -- info|warning|critical|HARD_FAIL|error
  category        text not null,   -- freshness|architecture_gate|...
  title           text not null,
  message         text not null,

  entity          jsonb not null default '{}'::jsonb,
  context         jsonb not null default '{}'::jsonb
);

create index if not exists idx_ops_issues_recent
  on public.ops_issues (created_at desc);

create index if not exists idx_ops_issues_severity_recent
  on public.ops_issues (severity, created_at desc);

create table if not exists public.quality_check_results (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),

  run_id            uuid not null,
  mode              text not null,

  check_category    text not null,
  status            text not null,
  execution_time_ms numeric(12,2) not null default 0,
  issue_count       int not null default 0,

  result_summary    jsonb not null default '{}'::jsonb,
  issue_details     jsonb not null default '[]'::jsonb
);

create index if not exists idx_quality_results_run
  on public.quality_check_results (run_id, created_at desc);

create index if not exists idx_quality_results_category_time
  on public.quality_check_results (check_category, created_at desc);

create index if not exists idx_quality_results_status_time
  on public.quality_check_results (status, created_at desc);

-- ---------- RLS: service_role only ----------
alter table public.quality_workerhealth enable row level security;
alter table public.quality_check_results enable row level security;
alter table public.ops_issues enable row level security;

do $$
begin
  -- Drop policies if they exist
  begin
    drop policy if exists "service_role_read_write_quality_workerhealth" on public.quality_workerhealth;
  exception when undefined_object then null; end;

  begin
    drop policy if exists "service_role_read_write_quality_check_results" on public.quality_check_results;
  exception when undefined_object then null; end;

  begin
    drop policy if exists "service_role_read_write_ops_issues" on public.ops_issues;
  exception when undefined_object then null; end;
end $$;

create policy "service_role_read_write_quality_workerhealth"
  on public.quality_workerhealth
  for all
  to service_role
  using (true)
  with check (true);

create policy "service_role_read_write_quality_check_results"
  on public.quality_check_results
  for all
  to service_role
  using (true)
  with check (true);

create policy "service_role_read_write_ops_issues"
  on public.ops_issues
  for all
  to service_role
  using (true)
  with check (true);

-- ---------- Helper: Severity rank ----------
drop function if exists public.rpc__severity_rank(text);

create or replace function public.rpc__severity_rank(p_status text)
returns int
language plpgsql
security definer
set search_path = public
as $$
begin
  case upper(coalesce(p_status,'PASS'))
    when 'PASS'      then return 1;
    when 'WARNING'   then return 2;
    when 'CRITICAL'  then return 3;
    when 'ERROR'     then return 4;
    when 'HARD_FAIL' then return 5;
    else return 4; -- unknown => treat as error-ish
  end case;
end;
$$;

revoke all on function public.rpc__severity_rank(text) from public;
grant execute on function public.rpc__severity_rank(text) to service_role;

-- ---------- Internal helper: write ops issue ----------
drop function if exists public.rpc__emit_ops_issue(uuid,text,text,text,text,jsonb,jsonb);

create or replace function public.rpc__emit_ops_issue(
  p_run_id uuid,
  p_severity text,
  p_category text,
  p_title text,
  p_message text,
  p_entity jsonb,
  p_context jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ops_issues (
    source, run_id, severity, category, title, message, entity, context
  ) values (
    'data_validation_worker',
    p_run_id,
    p_severity,
    p_category,
    p_title,
    p_message,
    coalesce(p_entity,'{}'::jsonb),
    coalesce(p_context,'{}'::jsonb)
  );
end;
$$;

revoke all on function public.rpc__emit_ops_issue(uuid,text,text,text,text,jsonb,jsonb) from public;
grant execute on function public.rpc__emit_ops_issue(uuid,text,text,text,text,jsonb,jsonb) to service_role;

-- =====================================================================
-- CHECK 1: Staleness
-- =====================================================================
drop function if exists public.rpc_check_staleness(text,int,int,int,boolean);

create or replace function public.rpc_check_staleness(
  p_env_name text,
  p_warning_threshold_minutes int default 5,
  p_critical_threshold_minutes int default 15,
  p_limit int default 100,
  p_respect_fx_weekend boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started  timestamptz := clock_timestamp();
  v_status   text := 'pass';
  v_issue_count int := 0;
  v_issues   jsonb := '[]'::jsonb;

  v_warning int := greatest(coalesce(p_warning_threshold_minutes,5), 1);
  v_critical int := greatest(coalesce(p_critical_threshold_minutes,15), v_warning+1);
  v_limit int := least(greatest(coalesce(p_limit,100),1), 500);

  v_is_weekend boolean := (extract(isodow from now() at time zone 'utc') in (6,7));
  v_summary jsonb;
begin
  perform set_config('statement_timeout', '5000ms', true);

  if p_env_name is null or btrim(p_env_name) = '' then
    raise exception 'env_name cannot be empty';
  end if;

  -- Optional weekend suppression for FX-style feeds.
  if p_respect_fx_weekend and v_is_weekend then
    return jsonb_build_object(
      'env_name', p_env_name,
      'status', 'pass',
      'check_category', 'freshness',
      'issue_count', 0,
      'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
      'result_summary', jsonb_build_object(
        'skipped_for_weekend_utc', true
      ),
      'issue_details', '[]'::jsonb
    );
  end if;

 with latest as (
    select * from (
      select distinct on (canonical_symbol, timeframe)
        canonical_symbol,
        timeframe,
        ts_utc as latest_bar_ts,
        'data_bars'::text as table_name
      from public.data_bars
      order by canonical_symbol, timeframe, ts_utc desc
    ) t1

    union all

    select * from (
      select distinct on (canonical_symbol, timeframe)
        canonical_symbol,
        timeframe,
        ts_utc as latest_bar_ts,
        'derived_data_bars'::text as table_name
      from public.derived_data_bars
      where timeframe in ('5m','1h','2h','4h','1d')
      order by canonical_symbol, timeframe, ts_utc desc
    ) t2
  ),
  scored as (
    select
      canonical_symbol,
      timeframe,
      table_name,
      latest_bar_ts,
      greatest(
        0,
        extract(epoch from (now() - latest_bar_ts)) / 60.0
      ) as staleness_minutes
    from latest
  ),
  flagged as (
    select
      canonical_symbol,
      timeframe,
      table_name,
      latest_bar_ts,
      staleness_minutes,
      case
        when staleness_minutes > v_critical then 'critical'
        when staleness_minutes > v_warning then 'warning'
        else 'pass'
      end as severity
    from scored
  ),
  issues as (
    select *
    from flagged
    where severity <> 'pass'
    order by staleness_minutes desc
    limit v_limit
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'canonical_symbol', canonical_symbol,
          'timeframe', timeframe,
          'table_name', table_name,
          'latest_bar_ts',
            to_char(latest_bar_ts,'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'staleness_minutes', round(staleness_minutes::numeric, 2),
          'severity', severity
        )
      ),
      '[]'::jsonb
    ),
    count(*)
  into v_issues, v_issue_count
  from issues;

  if v_issue_count > 0 then
    select
      case
        when exists (
          select 1
          from jsonb_array_elements(v_issues) e
          where upper(e->>'severity') = 'CRITICAL'
        ) then 'critical'
        else 'warning'
      end
    into v_status;
  end if;

  v_summary := jsonb_build_object(
    'warning_threshold_minutes', v_warning,
    'critical_threshold_minutes', v_critical,
    'pairs_flagged', v_issue_count
  );

  return jsonb_build_object(
    'env_name', p_env_name,
    'status', v_status,
    'check_category', 'freshness',
    'issue_count', v_issue_count,
    'execution_time_ms',
      round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', v_summary,
    'issue_details', v_issues
  );

exception when others then
  return jsonb_build_object(
    'env_name', coalesce(p_env_name,''),
    'status', 'error',
    'check_category', 'freshness',
    'issue_count', 1,
    'execution_time_ms',
      round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary',
      jsonb_build_object('error_message','staleness check failed'),
    'issue_details',
      jsonb_build_array(
        jsonb_build_object(
          'severity','error',
          'error_detail', sqlstate || ': ' || sqlerrm
        )
      )
  );
end;
$$;

revoke all on function public.rpc_check_staleness(text,int,int,int,boolean) from public;
grant execute on function public.rpc_check_staleness(text,int,int,int,boolean) to service_role;

-- =====================================================================
-- CHECK 2: Architecture gates (HARD_FAIL)
-- Gate A: derived_data_bars must NOT contain timeframe='1m'
-- Gate B: active 1m symbols must have recent 5m and 1h derived bars
-- =====================================================================
drop function if exists public.rpc_check_architecture_gates(text,int,int,int,int);

create or replace function public.rpc_check_architecture_gates(
  p_env_name text,
  p_active_lookback_minutes int default 120,
  p_5m_recency_minutes int default 30,
  p_1h_recency_minutes int default 360,
  p_limit int default 100
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_status text := 'pass';
  v_issue_count int := 0;
  v_limit int := least(greatest(coalesce(p_limit,100),1), 500);

  v_active_lookback int := least(greatest(coalesce(p_active_lookback_minutes,120), 30), 1440);
  v_5m_recency int := least(greatest(coalesce(p_5m_recency_minutes,30), 5), 1440);
  v_1h_recency int := least(greatest(coalesce(p_1h_recency_minutes,360), 60), 10080);

  v_issues jsonb := '[]'::jsonb;
  v_summary jsonb;
  v_has_derived_1m int := 0;
begin
  perform set_config('statement_timeout', '5000ms', true);

  if p_env_name is null or btrim(p_env_name) = '' then
    raise exception 'env_name cannot be empty';
  end if;

  -- Gate A: derived_data_bars must not have 1m
  select count(*) into v_has_derived_1m
  from public.derived_data_bars
  where timeframe = '1m';

  if v_has_derived_1m > 0 then
    v_status := 'HARD_FAIL';
    v_issue_count := v_issue_count + 1;
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'severity','HARD_FAIL',
      'gate','A',
      'message','derived_data_bars contains timeframe=1m rows (violates architecture invariant)',
      'count', v_has_derived_1m
    ));
  end if;

  -- Gate B: active symbols must have recent 5m and 1h derived bars
  with active as (
    select distinct canonical_symbol
    from public.data_bars
    where timeframe='1m'
      and ts_utc >= now() - make_interval(mins => v_active_lookback)
  ),
  latest5 as (
    select canonical_symbol, max(ts_utc) as max_5m_ts
    from public.derived_data_bars
    where timeframe='5m'
    group by canonical_symbol
  ),
  latest1h as (
    select canonical_symbol, max(ts_utc) as max_1h_ts
    from public.derived_data_bars
    where timeframe='1h'
    group by canonical_symbol
  ),
  joined as (
    select
      a.canonical_symbol,
      l5.max_5m_ts,
      l1.max_1h_ts,
      (l5.max_5m_ts is null or l5.max_5m_ts < now() - make_interval(mins => v_5m_recency)) as missing_5m_recent,
      (l1.max_1h_ts is null or l1.max_1h_ts < now() - make_interval(mins => v_1h_recency)) as missing_1h_recent
    from active a
    left join latest5 l5 on l5.canonical_symbol = a.canonical_symbol
    left join latest1h l1 on l1.canonical_symbol = a.canonical_symbol
  ),
  bad as (
    select *
    from joined
    where missing_5m_recent or missing_1h_recent
    order by canonical_symbol
    limit v_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'canonical_symbol', canonical_symbol,
      'missing_5m_recent', missing_5m_recent,
      'missing_1h_recent', missing_1h_recent,
      'latest_5m_ts', case when max_5m_ts is null then null else to_char(max_5m_ts,'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
      'latest_1h_ts', case when max_1h_ts is null then null else to_char(max_1h_ts,'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
      'severity','HARD_FAIL',
      'gate','B'
    )), '[]'::jsonb),
    count(*)
  into v_issues, v_issue_count
  from (
    select * from bad
    union all
    select null::text as canonical_symbol,
           null::timestamptz as max_5m_ts,
           null::timestamptz as max_1h_ts,
           false as missing_5m_recent,
           false as missing_1h_recent
    where false
  ) t;

  -- If gate B has any, force HARD_FAIL
  if v_issue_count > 0 then
    v_status := 'HARD_FAIL';
    -- v_issues currently includes only gate B issues; append gate A issue if exists
    if v_has_derived_1m > 0 then
      v_issues := jsonb_build_array(jsonb_build_object(
        'severity','HARD_FAIL',
        'gate','A',
        'message','derived_data_bars contains timeframe=1m rows (violates architecture invariant)',
        'count', v_has_derived_1m
      )) || v_issues;
      v_issue_count := v_issue_count + 1;
    end if;
  else
    -- no gate B issues; if only gate A triggered v_issue_count already >0
    if v_has_derived_1m > 0 then
      v_status := 'HARD_FAIL';
      v_issue_count := 1;
      v_issues := jsonb_build_array(jsonb_build_object(
        'severity','HARD_FAIL',
        'gate','A',
        'message','derived_data_bars contains timeframe=1m rows (violates architecture invariant)',
        'count', v_has_derived_1m
      ));
    end if;
  end if;

  v_summary := jsonb_build_object(
    'derived_has_1m_rows', v_has_derived_1m,
    'active_lookback_minutes', v_active_lookback,
    'recency_minutes_5m', v_5m_recency,
    'recency_minutes_1h', v_1h_recency,
    'violations_returned', v_issue_count
  );

  return jsonb_build_object(
    'env_name', p_env_name,
    'status', v_status,
    'severity_gate', case when v_status='HARD_FAIL' then 'HARD_FAIL' else null end,
    'check_category', 'architecture_gate',
    'issue_count', v_issue_count,
    'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', v_summary,
    'issue_details', v_issues
  );

exception when others then
  return jsonb_build_object(
    'env_name', coalesce(p_env_name,''),
    'status', 'error',
    'check_category', 'architecture_gate',
    'issue_count', 1,
    'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', jsonb_build_object('error_message','architecture gate failed'),
    'issue_details', jsonb_build_array(jsonb_build_object(
      'severity','error',
      'error_detail', sqlstate || ': ' || sqlerrm
    ))
  );
end;
$$;

revoke all on function public.rpc_check_architecture_gates(text,int,int,int,int) from public;
grant execute on function public.rpc_check_architecture_gates(text,int,int,int,int) to service_role;

-- =====================================================================
-- CHECK 3: Duplicates
-- =====================================================================
drop function if exists public.rpc_check_duplicates(text,int,int);

create or replace function public.rpc_check_duplicates(
  p_env_name text,
  p_window_days int default 7,
  p_limit int default 100
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_window int := least(greatest(coalesce(p_window_days,7), 1), 365);
  v_limit int := least(greatest(coalesce(p_limit,100),1), 500);
  v_issue_count int := 0;
  v_issues jsonb := '[]'::jsonb;
  v_status text := 'pass';
  v_summary jsonb;
begin
  perform set_config('statement_timeout', '10000ms', true);

  if p_env_name is null or btrim(p_env_name) = '' then
    raise exception 'env_name cannot be empty';
  end if;

  with dups as (
    select
      'data_bars'::text as table_name,
      canonical_symbol, timeframe, ts_utc,
      count(*) as duplicate_count
    from public.data_bars
    where ts_utc >= now() - make_interval(days => v_window)
    group by canonical_symbol, timeframe, ts_utc
    having count(*) > 1

    union all

    select
      'derived_data_bars'::text as table_name,
      canonical_symbol, timeframe, ts_utc,
      count(*) as duplicate_count
    from public.derived_data_bars
    where ts_utc >= now() - make_interval(days => v_window)
    group by canonical_symbol, timeframe, ts_utc
    having count(*) > 1
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'table_name', table_name,
      'canonical_symbol', canonical_symbol,
      'timeframe', timeframe,
      'ts_utc', to_char(ts_utc,'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'duplicate_count', duplicate_count,
      'severity', 'critical'
    ) order by duplicate_count desc), '[]'::jsonb),
    count(*)
  into v_issues, v_issue_count
  from (
    select * from dups
    order by duplicate_count desc
    limit v_limit
  ) x;

  if v_issue_count > 0 then
    v_status := 'critical';
  end if;

  v_summary := jsonb_build_object(
    'window_days', v_window,
    'duplicates_returned', v_issue_count
  );

  return jsonb_build_object(
    'env_name', p_env_name,
    'status', v_status,
    'check_category', 'data_integrity',
    'issue_count', v_issue_count,
    'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', v_summary,
    'issue_details', v_issues
  );

exception when others then
  return jsonb_build_object(
    'env_name', coalesce(p_env_name,''),
    'status', 'error',
    'check_category', 'data_integrity',
    'issue_count', 1,
    'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', jsonb_build_object('error_message','duplicates check failed'),
    'issue_details', jsonb_build_array(jsonb_build_object(
      'severity','error',
      'error_detail', sqlstate || ': ' || sqlerrm
    ))
  );
end;
$$;

revoke all on function public.rpc_check_duplicates(text,int,int) from public;
grant execute on function public.rpc_check_duplicates(text,int,int) to service_role;

-- =====================================================================
-- CHECK 4: DXY components presence/recency (1m only)
-- =====================================================================
drop function if exists public.rpc_check_dxy_components(text,int,text,int);

create or replace function public.rpc_check_dxy_components(
  p_env_name text,
  p_lookback_minutes int default 30,
  p_dxy_symbols text default 'EURUSD,USDJPY,GBPUSD,USDCAD,USDSEK,USDCHF',
  p_limit int default 50
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_lookback int := least(greatest(coalesce(p_lookback_minutes,30), 1), 1440);
  v_limit int := least(greatest(coalesce(p_limit,50),1), 200);
  v_syms text[];
  v_issue_count int := 0;
  v_issues jsonb := '[]'::jsonb;
  v_status text := 'pass';
  v_summary jsonb;
begin
  perform set_config('statement_timeout', '5000ms', true);

  if p_env_name is null or btrim(p_env_name) = '' then
    raise exception 'env_name cannot be empty';
  end if;

  v_syms := string_to_array(replace(coalesce(p_dxy_symbols,''),' ',''), ',');
  if v_syms is null or array_length(v_syms,1) is null or array_length(v_syms,1) = 0 then
    raise exception 'p_dxy_symbols must contain at least one symbol';
  end if;

  with latest as (
    select
      canonical_symbol,
      max(ts_utc) as latest_ts
    from public.data_bars
    where timeframe='1m'
      and canonical_symbol = any (v_syms)
    group by canonical_symbol
  ),
  scored as (
    select
      s.sym as canonical_symbol,
      l.latest_ts,
      case
        when l.latest_ts is null then null
        else greatest(0, extract(epoch from (now() - l.latest_ts))/60.0)
      end as staleness_minutes
    from unnest(v_syms) as s(sym)
    left join latest l on l.canonical_symbol = s.sym
  ),
  issues as (
    select
      canonical_symbol,
      latest_ts,
      staleness_minutes,
      case
        when latest_ts is null then 'critical'
        when staleness_minutes > v_lookback then 'critical'
        else 'pass'
      end as severity
    from scored
    where (latest_ts is null) or (staleness_minutes > v_lookback)
    order by coalesce(staleness_minutes, 1e9) desc
    limit v_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'canonical_symbol', canonical_symbol,
      'latest_bar_ts', case when latest_ts is null then null else to_char(latest_ts,'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
      'staleness_minutes', case when staleness_minutes is null then null else round(staleness_minutes::numeric,2) end,
      'severity', severity
    )), '[]'::jsonb),
    count(*)
  into v_issues, v_issue_count
  from issues;

  if v_issue_count > 0 then
    v_status := 'critical';
  end if;

  v_summary := jsonb_build_object(
    'lookback_minutes', v_lookback,
    'total_dxy_symbols_expected', array_length(v_syms,1),
    'symbols_missing_or_stale', v_issue_count
  );

  return jsonb_build_object(
    'env_name', p_env_name,
    'status', v_status,
    'check_category', 'dxy_components',
    'issue_count', v_issue_count,
    'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', v_summary,
    'issue_details', v_issues
  );

exception when others then
  return jsonb_build_object(
    'env_name', coalesce(p_env_name,''),
    'status', 'error',
    'check_category', 'dxy_components',
    'issue_count', 1,
    'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', jsonb_build_object('error_message','dxy components check failed'),
    'issue_details', jsonb_build_array(jsonb_build_object(
      'severity','error',
      'error_detail', sqlstate || ': ' || sqlerrm
    ))
  );
end;
$$;

revoke all on function public.rpc_check_dxy_components(text,int,text,int) from public;
grant execute on function public.rpc_check_dxy_components(text,int,text,int) to service_role;

-- =====================================================================
-- CHECK 5: Aggregation reconciliation sample (START-LABELED)
-- Samples derived 5m and 1h bars; re-aggregates from 1m source.
-- =====================================================================
drop function if exists public.rpc_check_aggregation_reconciliation_sample(text,int,int,double precision,boolean);

create or replace function public.rpc_check_aggregation_reconciliation_sample(
  p_env_name text,
  p_lookback_days int default 7,
  p_sample_size int default 50,
  p_tolerance_ratio double precision default 0.001,
  p_include_details boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_days int := least(greatest(coalesce(p_lookback_days,7), 1), 60);
  v_n int := least(greatest(coalesce(p_sample_size,50), 1), 100);
  v_tol double precision := least(greatest(coalesce(p_tolerance_ratio,0.001), 0.0), 0.05);

  v_issue_count int := 0;
  v_status text := 'pass';
  v_issues jsonb := '[]'::jsonb;

  v_checked int := 0;
begin
  perform set_config('statement_timeout', '10000ms', true);

  if p_env_name is null or btrim(p_env_name) = '' then
    raise exception 'env_name cannot be empty';
  end if;

  -- Sample derived bars (5m + 1h) from lookback window.
  -- NOTE: ORDER BY random() is acceptable for small v_n (<=100); bounded by time window.
  with sample as (
    select canonical_symbol, timeframe, ts_utc,
           open, high, low, close, volume
    from public.derived_data_bars
    where timeframe in ('5m','1h')
      and ts_utc >= now() - make_interval(days => v_days)
    order by random()
    limit v_n
  ),
  recalced as (
    select
      s.canonical_symbol,
      s.timeframe,
      s.ts_utc as derived_ts,
      s.open as stored_open,
      s.high as stored_high,
      s.low  as stored_low,
      s.close as stored_close,
      s.volume as stored_volume,

      -- START-LABELED window
      (case when s.timeframe='5m' then s.ts_utc + interval '5 minutes'
            else s.ts_utc + interval '1 hour' end) as window_end,

      -- Re-aggregate from 1m source (data_bars only)
      (select b.open from public.data_bars b
        where b.canonical_symbol=s.canonical_symbol
          and b.timeframe='1m'
          and b.ts_utc >= s.ts_utc
          and b.ts_utc < (case when s.timeframe='5m' then s.ts_utc + interval '5 minutes' else s.ts_utc + interval '1 hour' end)
        order by b.ts_utc asc
        limit 1) as rec_open,

      (select max(b.high) from public.data_bars b
        where b.canonical_symbol=s.canonical_symbol
          and b.timeframe='1m'
          and b.ts_utc >= s.ts_utc
          and b.ts_utc < (case when s.timeframe='5m' then s.ts_utc + interval '5 minutes' else s.ts_utc + interval '1 hour' end)
      ) as rec_high,

      (select min(b.low) from public.data_bars b
        where b.canonical_symbol=s.canonical_symbol
          and b.timeframe='1m'
          and b.ts_utc >= s.ts_utc
          and b.ts_utc < (case when s.timeframe='5m' then s.ts_utc + interval '5 minutes' else s.ts_utc + interval '1 hour' end)
      ) as rec_low,

      (select b.close from public.data_bars b
        where b.canonical_symbol=s.canonical_symbol
          and b.timeframe='1m'
          and b.ts_utc >= s.ts_utc
          and b.ts_utc < (case when s.timeframe='5m' then s.ts_utc + interval '5 minutes' else s.ts_utc + interval '1 hour' end)
        order by b.ts_utc desc
        limit 1) as rec_close,

      (select sum(b.volume) from public.data_bars b
        where b.canonical_symbol=s.canonical_symbol
          and b.timeframe='1m'
          and b.ts_utc >= s.ts_utc
          and b.ts_utc < (case when s.timeframe='5m' then s.ts_utc + interval '5 minutes' else s.ts_utc + interval '1 hour' end)
      ) as rec_volume
    from sample s
  ),
  scored as (
    select
      r.*,
      -- deviation ratios (NULL-safe)
      case when r.stored_open is null or r.stored_open=0 or r.rec_open is null then null
           else abs(r.stored_open - r.rec_open) / abs(r.stored_open) end as dev_open,
      case when r.stored_high is null or r.stored_high=0 or r.rec_high is null then null
           else abs(r.stored_high - r.rec_high) / abs(r.stored_high) end as dev_high,
      case when r.stored_low is null or r.stored_low=0 or r.rec_low is null then null
           else abs(r.stored_low - r.rec_low) / abs(r.stored_low) end as dev_low,
      case when r.stored_close is null or r.stored_close=0 or r.rec_close is null then null
           else abs(r.stored_close - r.rec_close) / abs(r.stored_close) end as dev_close,
      case when r.stored_volume is null or r.stored_volume=0 or r.rec_volume is null then null
           else abs(r.stored_volume - r.rec_volume) / abs(r.stored_volume) end as dev_volume
    from recalced r
  ),
  mismatches as (
    select
      *,
      greatest(
        coalesce(dev_open,0),
        coalesce(dev_high,0),
        coalesce(dev_low,0),
        coalesce(dev_close,0),
        coalesce(dev_volume,0)
      ) as max_dev
    from scored
    where
      rec_open is null or rec_high is null or rec_low is null or rec_close is null
      or greatest(
        coalesce(dev_open,0),
        coalesce(dev_high,0),
        coalesce(dev_low,0),
        coalesce(dev_close,0),
        coalesce(dev_volume,0)
      ) > v_tol
  )
  select
    count(*) as mismatches_found,
    (select count(*) from sample) as sample_count,
    coalesce(jsonb_agg(
      jsonb_build_object(
        'canonical_symbol', canonical_symbol,
        'timeframe', timeframe,
        'derived_ts', to_char(derived_ts,'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'max_deviation_ratio', round(max_dev::numeric, 6),
        'severity', case when max_dev > (v_tol*5) then 'critical' else 'warning' end,
        'stored', jsonb_build_object('open',stored_open,'high',stored_high,'low',stored_low,'close',stored_close,'volume',stored_volume),
        'recalc', jsonb_build_object('open',rec_open,'high',rec_high,'low',rec_low,'close',rec_close,'volume',rec_volume)
      )
      order by max_dev desc
    ), '[]'::jsonb) as issues_json
  into v_issue_count, v_checked, v_issues
  from (
    select *
    from mismatches
    order by max_dev desc
    limit 50
  ) m;

  if v_issue_count > 0 then
    v_status := 'warning';
    if exists (select 1 from jsonb_array_elements(v_issues) e where upper(e->>'severity')='CRITICAL') then
      v_status := 'critical';
    end if;

    if not p_include_details then
      -- Strip heavy stored/recalc blobs if not requested
      v_issues := (
        select coalesce(jsonb_agg(
          (e - 'stored' - 'recalc')
        ), '[]'::jsonb)
        from jsonb_array_elements(v_issues) e
      );
    end if;
  end if;

  return jsonb_build_object(
    'env_name', p_env_name,
    'status', v_status,
    'check_category', 'reconciliation',
    'issue_count', v_issue_count,
    'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', jsonb_build_object(
      'sample_size', v_checked,
      'lookback_days', v_days,
      'tolerance_ratio', v_tol,
      'mismatches_found', v_issue_count
    ),
    'issue_details', v_issues
  );

exception when others then
  return jsonb_build_object(
    'env_name', coalesce(p_env_name,''),
    'status', 'error',
    'check_category', 'reconciliation',
    'issue_count', 1,
    'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', jsonb_build_object('error_message','reconciliation check failed'),
    'issue_details', jsonb_build_array(jsonb_build_object(
      'severity','error',
      'error_detail', sqlstate || ': ' || sqlerrm
    ))
  );
end;
$$;

revoke all on function public.rpc_check_aggregation_reconciliation_sample(text,int,int,double precision,boolean) from public;
grant execute on function public.rpc_check_aggregation_reconciliation_sample(text,int,int,double precision,boolean) to service_role;

-- =====================================================================
-- CHECK 6: OHLC integrity sample (data_bars + derived_data_bars)
-- =====================================================================
drop function if exists public.rpc_check_ohlc_integrity_sample(text,int,int,double precision);

create or replace function public.rpc_check_ohlc_integrity_sample(
  p_env_name text,
  p_lookback_days int default 7,
  p_sample_size int default 1000,
  p_volume_min double precision default 0.01
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_days int := least(greatest(coalesce(p_lookback_days,7), 1), 60);
  v_n int := least(greatest(coalesce(p_sample_size,1000), 1), 5000);
  v_volmin double precision := greatest(coalesce(p_volume_min,0.01), 0.0);

  v_issue_count int := 0;
  v_status text := 'pass';
  v_issues jsonb := '[]'::jsonb;
begin
  perform set_config('statement_timeout', '5000ms', true);

  if p_env_name is null or btrim(p_env_name) = '' then
    raise exception 'env_name cannot be empty';
  end if;

  with sample as (
  select * from (
    select
      'data_bars'::text as table_name,
      canonical_symbol, timeframe, ts_utc,
      open, high, low, close, volume
    from public.data_bars
    where ts_utc >= now() - make_interval(days => v_days)
    order by random()
    limit (v_n/2)
  ) s1

  union all

  select * from (
    select
      'derived_data_bars'::text as table_name,
      canonical_symbol, timeframe, ts_utc,
      open, high, low, close, volume
    from public.derived_data_bars
    where ts_utc >= now() - make_interval(days => v_days)
    order by random()
    limit (v_n - (v_n/2))
  ) s2
),

  bad as (
    select *,
      case
        when open is null or high is null or low is null or close is null then 'null_ohlc'
        when open <= 0 or high <= 0 or low <= 0 or close <= 0 then 'non_positive_price'
        when high < greatest(open, close) then 'high_below_open_or_close'
        when low  > least(open, close) then 'low_above_open_or_close'
        when low > high then 'low_above_high'
        when volume is null then 'null_volume'
        when volume < v_volmin then 'low_volume'
        else null
      end as violation
    from sample
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'table_name', table_name,
      'canonical_symbol', canonical_symbol,
      'timeframe', timeframe,
      'ts_utc', to_char(ts_utc,'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'open', open, 'high', high, 'low', low, 'close', close, 'volume', volume,
      'violation', violation,
      'severity', 'critical'
    )), '[]'::jsonb),
    count(*)
  into v_issues, v_issue_count
  from (
    select * from bad where violation is not null limit 200
  ) x;

  if v_issue_count > 0 then
    v_status := 'critical';
  end if;

  return jsonb_build_object(
    'env_name', p_env_name,
    'status', v_status,
    'check_category', 'ohlc_integrity',
    'issue_count', v_issue_count,
    'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', jsonb_build_object(
      'sample_size', v_n,
      'lookback_days', v_days,
      'violations_found', v_issue_count,
      'volume_min', v_volmin
    ),
    'issue_details', v_issues
  );

exception when others then
  return jsonb_build_object(
    'env_name', coalesce(p_env_name,''),
    'status', 'error',
    'check_category', 'ohlc_integrity',
    'issue_count', 1,
    'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', jsonb_build_object('error_message','ohlc integrity check failed'),
    'issue_details', jsonb_build_array(jsonb_build_object(
      'severity','error',
      'error_detail', sqlstate || ': ' || sqlerrm
    ))
  );
end;
$$;

revoke all on function public.rpc_check_ohlc_integrity_sample(text,int,int,double precision) from public;
grant execute on function public.rpc_check_ohlc_integrity_sample(text,int,int,double precision) to service_role;

-- =====================================================================
-- CHECK 7: Gap density (recent 24h)
-- =====================================================================
drop function if exists public.rpc_check_gap_density(text,int);

create or replace function public.rpc_check_gap_density(
  p_env_name text,
  p_limit int default 100
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_limit int := least(greatest(coalesce(p_limit,100),1), 500);
  v_issue_count int := 0;
  v_status text := 'pass';
  v_issues jsonb := '[]'::jsonb;
begin
  perform set_config('statement_timeout', '10000ms', true);

  if p_env_name is null or btrim(p_env_name) = '' then
    raise exception 'env_name cannot be empty';
  end if;

  with recent as (
    select canonical_symbol, timeframe, ts_utc
    from public.data_bars
    where ts_utc >= now() - interval '24 hours'
  ),
  lagged as (
    select
      canonical_symbol, timeframe, ts_utc,
      lag(ts_utc) over (partition by canonical_symbol, timeframe order by ts_utc) as prev_ts
    from recent
  ),
  gaps as (
    select
      canonical_symbol,
      timeframe,
      prev_ts as gap_start,
      ts_utc as gap_end,
      extract(epoch from (ts_utc - prev_ts)) as gap_seconds,
      case timeframe
        when '1m' then 60
        when '5m' then 300
        when '1h' then 3600
        else null
      end as expected_seconds
    from lagged
    where prev_ts is not null
  ),
  flagged as (
    select *,
      (gap_seconds / expected_seconds) as gap_multiple
    from gaps
    where expected_seconds is not null
      and gap_seconds > (2 * expected_seconds)
    order by gap_seconds desc
    limit v_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'canonical_symbol', canonical_symbol,
      'timeframe', timeframe,
      'gap_start', to_char(gap_start,'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'gap_end', to_char(gap_end,'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'gap_seconds', gap_seconds,
      'gap_minutes', round((gap_seconds/60.0)::numeric, 2),
      'expected_interval_seconds', expected_seconds,
      'severity','warning'
    )), '[]'::jsonb),
    count(*)
  into v_issues, v_issue_count
  from flagged;

  if v_issue_count > 0 then
    v_status := 'warning';
  end if;

  return jsonb_build_object(
    'env_name', p_env_name,
    'status', v_status,
    'check_category', 'continuity',
    'issue_count', v_issue_count,
    'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', jsonb_build_object(
      'scan_window_hours', 24,
      'total_gaps_found', v_issue_count
    ),
    'issue_details', v_issues
  );

exception when others then
  return jsonb_build_object(
    'env_name', coalesce(p_env_name,''),
    'status', 'error',
    'check_category', 'continuity',
    'issue_count', 1,
    'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', jsonb_build_object('error_message','gap density check failed'),
    'issue_details', jsonb_build_array(jsonb_build_object(
      'severity','error',
      'error_detail', sqlstate || ': ' || sqlerrm
    ))
  );
end;
$$;

revoke all on function public.rpc_check_gap_density(text,int) from public;
grant execute on function public.rpc_check_gap_density(text,int) to service_role;

-- =====================================================================
-- CHECK 8: Coverage ratios (assumes 24/7 unless weekend suppression enabled)
-- =====================================================================
drop function if exists public.rpc_check_coverage_ratios(text,int,double precision,int,boolean);

create or replace function public.rpc_check_coverage_ratios(
  p_env_name text,
  p_lookback_hours int default 24,
  p_min_coverage_ratio double precision default 0.95,
  p_limit int default 100,
  p_respect_fx_weekend boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_hours int := least(greatest(coalesce(p_lookback_hours,24), 1), 168);
  v_min double precision := least(greatest(coalesce(p_min_coverage_ratio,0.95), 0.0), 1.0);
  v_limit int := least(greatest(coalesce(p_limit,100),1), 500);

  v_is_weekend boolean := (extract(isodow from now() at time zone 'utc') in (6,7));

  v_issue_count int := 0;
  v_status text := 'pass';
  v_issues jsonb := '[]'::jsonb;
begin
  perform set_config('statement_timeout', '5000ms', true);

  if p_env_name is null or btrim(p_env_name) = '' then
    raise exception 'env_name cannot be empty';
  end if;

  if p_respect_fx_weekend and v_is_weekend then
    return jsonb_build_object(
      'env_name', p_env_name,
      'status', 'pass',
      'check_category', 'coverage',
      'issue_count', 0,
      'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
      'result_summary', jsonb_build_object('skipped_for_weekend_utc', true),
      'issue_details', '[]'::jsonb
    );
  end if;

  with counts as (
    select
      canonical_symbol,
      timeframe,
      count(*) as actual_bars
    from public.data_bars
    where ts_utc >= now() - make_interval(hours => v_hours)
      and timeframe in ('1m','5m','1h')
    group by canonical_symbol, timeframe
  ),
  expected as (
    select
      canonical_symbol,
      timeframe,
      actual_bars,
      case timeframe
        when '1m' then (v_hours*60)
        when '5m' then ((v_hours*60)/5)
        when '1h' then v_hours
        else null
      end as expected_bars
    from counts
  ),
  scored as (
    select *,
      case when expected_bars is null or expected_bars=0 then null
           else (actual_bars::double precision / expected_bars::double precision) end as coverage_ratio
    from expected
  ),
  bad as (
    select *
    from scored
    where coverage_ratio is not null
      and coverage_ratio < v_min
    order by coverage_ratio asc
    limit v_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'canonical_symbol', canonical_symbol,
      'timeframe', timeframe,
      'expected_bars', expected_bars,
      'actual_bars', actual_bars,
      'coverage_ratio', round(coverage_ratio::numeric, 4),
      'severity','warning'
    )), '[]'::jsonb),
    count(*)
  into v_issues, v_issue_count
  from bad;

  if v_issue_count > 0 then
    v_status := 'warning';
  end if;

  return jsonb_build_object(
    'env_name', p_env_name,
    'status', v_status,
    'check_category', 'coverage',
    'issue_count', v_issue_count,
    'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', jsonb_build_object(
      'lookback_hours', v_hours,
      'min_coverage_ratio', v_min,
      'symbols_below_threshold', v_issue_count
    ),
    'issue_details', v_issues
  );

exception when others then
  return jsonb_build_object(
    'env_name', coalesce(p_env_name,''),
    'status', 'error',
    'check_category', 'coverage',
    'issue_count', 1,
    'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', jsonb_build_object('error_message','coverage ratios check failed'),
    'issue_details', jsonb_build_array(jsonb_build_object(
      'severity','error',
      'error_detail', sqlstate || ': ' || sqlerrm
    ))
  );
end;
$$;

revoke all on function public.rpc_check_coverage_ratios(text,int,double precision,int,boolean) from public;
grant execute on function public.rpc_check_coverage_ratios(text,int,double precision,int,boolean) to service_role;

-- =====================================================================
-- CHECK 9: Historical integrity sample (excludes most recent hours)
-- =====================================================================
drop function if exists public.rpc_check_historical_integrity_sample(text,int,int,int,double precision);

create or replace function public.rpc_check_historical_integrity_sample(
  p_env_name text,
  p_history_days int default 30,
  p_sample_size int default 100,
  p_max_recent_hours int default 48,
  p_volume_min double precision default 0.01
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_days int := least(greatest(coalesce(p_history_days,30), 2), 365);
  v_n int := least(greatest(coalesce(p_sample_size,100), 1), 1000);
  v_excl int := least(greatest(coalesce(p_max_recent_hours,48), 1), 168);
  v_volmin double precision := greatest(coalesce(p_volume_min,0.01), 0.0);

  v_issue_count int := 0;
  v_status text := 'pass';
  v_issues jsonb := '[]'::jsonb;
begin
  perform set_config('statement_timeout', '10000ms', true);

  if p_env_name is null or btrim(p_env_name) = '' then
    raise exception 'env_name cannot be empty';
  end if;

  with sample as (
    select canonical_symbol, timeframe, ts_utc, open, high, low, close, volume
    from public.data_bars
    where ts_utc >= now() - make_interval(days => v_days)
      and ts_utc <  now() - make_interval(hours => v_excl)
    order by random()
    limit v_n
  ),
  bad as (
    select *,
      case
        when open is null or high is null or low is null or close is null then 'null_ohlc'
        when open <= 0 or high <= 0 or low <= 0 or close <= 0 then 'non_positive_price'
        when high < greatest(open, close) then 'high_below_open_or_close'
        when low  > least(open, close) then 'low_above_open_or_close'
        when low > high then 'low_above_high'
        when volume is null then 'null_volume'
        when volume < v_volmin then 'low_volume'
        else null
      end as violation
    from sample
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'canonical_symbol', canonical_symbol,
      'timeframe', timeframe,
      'ts_utc', to_char(ts_utc,'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'violation', violation,
      'severity','warning'
    )), '[]'::jsonb),
    count(*)
  into v_issues, v_issue_count
  from (
    select * from bad where violation is not null limit 200
  ) x;

  if v_issue_count > 0 then
    v_status := 'warning';
  end if;

  return jsonb_build_object(
    'env_name', p_env_name,
    'status', v_status,
    'check_category', 'historical_integrity',
    'issue_count', v_issue_count,
    'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', jsonb_build_object(
      'history_days', v_days,
      'excluded_recent_hours', v_excl,
      'sample_size', v_n,
      'violations_found', v_issue_count
    ),
    'issue_details', v_issues
  );

exception when others then
  return jsonb_build_object(
    'env_name', coalesce(p_env_name,''),
    'status', 'error',
    'check_category', 'historical_integrity',
    'issue_count', 1,
    'execution_time_ms', round(extract(epoch from (clock_timestamp()-v_started))*1000, 2),
    'result_summary', jsonb_build_object('error_message','historical integrity check failed'),
    'issue_details', jsonb_build_array(jsonb_build_object(
      'severity','error',
      'error_detail', sqlstate || ': ' || sqlerrm
    ))
  );
end;
$$;

revoke all on function public.rpc_check_historical_integrity_sample(text,int,int,int,double precision) from public;
grant execute on function public.rpc_check_historical_integrity_sample(text,int,int,int,double precision) to service_role;


-- =====================================================================
-- Orchestrator: rpc_run_health_checks
-- Executes checks, persists results, creates ops_issues, logs worker run
-- =====================================================================
drop function if exists public.rpc_run_health_checks(text,text,text);

create or replace function public.rpc_run_health_checks(
  p_env_name text,
  p_mode text default 'fast',
  p_trigger text default 'cron'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid := gen_random_uuid();
  v_started timestamptz := clock_timestamp();
  v_finished timestamptz;

  v_mode text := lower(coalesce(p_mode,'fast'));
  v_trigger text := lower(coalesce(p_trigger,'cron'));

  v_overall text := 'pass';
  v_overall_rank int := public.rpc__severity_rank('pass');

  v_checks jsonb := '[]'::jsonb;
  v_checks_run int := 0;
  v_total_issues int := 0;

  v_check jsonb;
  v_cat text;
  v_status text;
  v_rank int;
  v_issue_count int;
begin
  perform set_config('statement_timeout', '60000ms', true);

  if p_env_name is null or btrim(p_env_name) = '' then
    raise exception 'env_name cannot be empty';
  end if;

  if v_mode not in ('fast','full') then
    raise exception 'p_mode must be fast or full';
  end if;

  if v_trigger not in ('cron','manual','api') then
    raise exception 'p_trigger must be cron|manual|api';
  end if;

  -- ===============================================================
  -- a) Architecture gates
  -- ===============================================================
  v_check := public.rpc_check_architecture_gates(p_env_name, 120, 30, 360, 100);
  v_checks := v_checks || jsonb_build_array(v_check);
  v_checks_run := v_checks_run + 1;

  insert into public.quality_check_results (
    run_id, mode, check_category, status,
    execution_time_ms, issue_count,
    result_summary, issue_details
  ) values (
    v_run_id,
    v_mode,
    v_check->>'check_category',
    v_check->>'status',
    coalesce((v_check->>'execution_time_ms')::numeric,0),
    coalesce((v_check->>'issue_count')::int,0),
    coalesce(v_check->'result_summary','{}'::jsonb),
    coalesce(v_check->'issue_details','[]'::jsonb)
  );

  v_cat := v_check->>'check_category';
  v_status := v_check->>'status';
  v_issue_count := coalesce((v_check->>'issue_count')::int,0);

  if v_status <> 'pass' then
    perform public.rpc__emit_ops_issue(
      v_run_id, v_status, v_cat,
      'Architecture gate violation',
      'One or more architecture invariants failed',
      '{}'::jsonb, v_check
    );
  end if;

  v_rank := public.rpc__severity_rank(v_status);
  if v_rank > v_overall_rank then v_overall := v_status; v_overall_rank := v_rank; end if;
  v_total_issues := v_total_issues + v_issue_count;

  -- ===============================================================
  -- b) Staleness
  -- ===============================================================
  v_check := public.rpc_check_staleness(p_env_name, 5, 15, 100, true);
  v_checks := v_checks || jsonb_build_array(v_check);
  v_checks_run := v_checks_run + 1;

  insert into public.quality_check_results (run_id, mode, check_category, status, execution_time_ms, issue_count, result_summary, issue_details)
  select
    v_run_id,
    v_mode,
    v_check->>'check_category',
    v_check->>'status',
    coalesce((v_check->>'execution_time_ms')::numeric,0),
    coalesce((v_check->>'issue_count')::int,0),
    coalesce(v_check->'result_summary','{}'::jsonb),
    coalesce(v_check->'issue_details','[]'::jsonb);

  v_cat := v_check->>'check_category';
  v_status := v_check->>'status';
  v_issue_count := coalesce((v_check->>'issue_count')::int,0);

  if v_status <> 'pass' then
    perform public.rpc__emit_ops_issue(
      v_run_id, v_status, v_cat,
      'Data freshness issues detected',
      'One or more series are stale beyond thresholds',
      '{}'::jsonb, v_check
    );
  end if;

  v_rank := public.rpc__severity_rank(v_status);
  if v_rank > v_overall_rank then v_overall := v_status; v_overall_rank := v_rank; end if;
  v_total_issues := v_total_issues + v_issue_count;

  -- ===============================================================
  -- c) DXY components
  -- ===============================================================
  v_check := public.rpc_check_dxy_components(
    p_env_name,
    30,
    'EURUSD,USDJPY,GBPUSD,USDCAD,USDSEK,USDCHF',
    50
  );
  v_checks := v_checks || jsonb_build_array(v_check);
  v_checks_run := v_checks_run + 1;

  insert into public.quality_check_results (run_id, mode, check_category, status, execution_time_ms, issue_count, result_summary, issue_details)
  select
    v_run_id,
    v_mode,
    v_check->>'check_category',
    v_check->>'status',
    coalesce((v_check->>'execution_time_ms')::numeric,0),
    coalesce((v_check->>'issue_count')::int,0),
    coalesce(v_check->'result_summary','{}'::jsonb),
    coalesce(v_check->'issue_details','[]'::jsonb);

  v_cat := v_check->>'check_category';
  v_status := v_check->>'status';
  v_issue_count := coalesce((v_check->>'issue_count')::int,0);

  if v_status <> 'pass' then
    perform public.rpc__emit_ops_issue(
      v_run_id, v_status, v_cat,
      'DXY component feed issue',
      'One or more DXY components are missing or stale',
      '{}'::jsonb, v_check
    );
  end if;

  v_rank := public.rpc__severity_rank(v_status);
  if v_rank > v_overall_rank then v_overall := v_status; v_overall_rank := v_rank; end if;
  v_total_issues := v_total_issues + v_issue_count;

  -- ===============================================================
  -- d) Reconciliation
  -- ===============================================================
  v_check := public.rpc_check_aggregation_reconciliation_sample(
    p_env_name, 7, 50, 0.001, false
  );
  v_checks := v_checks || jsonb_build_array(v_check);
  v_checks_run := v_checks_run + 1;

  insert into public.quality_check_results (run_id, mode, check_category, status, execution_time_ms, issue_count, result_summary, issue_details)
  select
    v_run_id,
    v_mode,
    v_check->>'check_category',
    v_check->>'status',
    coalesce((v_check->>'execution_time_ms')::numeric,0),
    coalesce((v_check->>'issue_count')::int,0),
    coalesce(v_check->'result_summary','{}'::jsonb),
    coalesce(v_check->'issue_details','[]'::jsonb);

  v_cat := v_check->>'check_category';
  v_status := v_check->>'status';
  v_issue_count := coalesce((v_check->>'issue_count')::int,0);

  if v_status <> 'pass' then
    perform public.rpc__emit_ops_issue(
      v_run_id, v_status, v_cat,
      'Aggregation reconciliation mismatch',
      'Derived bars do not reconcile with re-aggregation from 1m source',
      '{}'::jsonb, v_check
    );
  end if;

  v_rank := public.rpc__severity_rank(v_status);
  if v_rank > v_overall_rank then v_overall := v_status; v_overall_rank := v_rank; end if;
  v_total_issues := v_total_issues + v_issue_count;

  -- ===============================================================
  -- e) OHLC integrity sample
  -- ===============================================================
  v_check := public.rpc_check_ohlc_integrity_sample(p_env_name, 7, 1000, 0.01);
  v_checks := v_checks || jsonb_build_array(v_check);
  v_checks_run := v_checks_run + 1;

  insert into public.quality_check_results (run_id, mode, check_category, status, execution_time_ms, issue_count, result_summary, issue_details)
  select
    v_run_id,
    v_mode,
    v_check->>'check_category',
    v_check->>'status',
    coalesce((v_check->>'execution_time_ms')::numeric,0),
    coalesce((v_check->>'issue_count')::int,0),
    coalesce(v_check->'result_summary','{}'::jsonb),
    coalesce(v_check->'issue_details','[]'::jsonb);

  v_cat := v_check->>'check_category';
  v_status := v_check->>'status';
  v_issue_count := coalesce((v_check->>'issue_count')::int,0);

  if v_status <> 'pass' then
    perform public.rpc__emit_ops_issue(
      v_run_id, v_status, v_cat,
      'OHLC integrity violation',
      'One or more sampled bars violate OHLC/volume constraints',
      '{}'::jsonb, v_check
    );
  end if;

  v_rank := public.rpc__severity_rank(v_status);
  if v_rank > v_overall_rank then v_overall := v_status; v_overall_rank := v_rank; end if;
  v_total_issues := v_total_issues + v_issue_count;

  -- ===============================================================
  -- FULL MODE CHECKS
  -- ===============================================================
  if v_mode = 'full' then
    -- duplicates
    v_check := public.rpc_check_duplicates(p_env_name, 7, 100);
    v_checks := v_checks || jsonb_build_array(v_check);
    v_checks_run := v_checks_run + 1;

    insert into public.quality_check_results (run_id, mode, check_category, status, execution_time_ms, issue_count, result_summary, issue_details)
    select
      v_run_id,
      v_mode,
      v_check->>'check_category',
      v_check->>'status',
      coalesce((v_check->>'execution_time_ms')::numeric,0),
      coalesce((v_check->>'issue_count')::int,0),
      coalesce(v_check->'result_summary','{}'::jsonb),
      coalesce(v_check->'issue_details','[]'::jsonb);

    v_cat := v_check->>'check_category';
    v_status := v_check->>'status';
    v_issue_count := coalesce((v_check->>'issue_count')::int,0);

    if v_status <> 'pass' then
      perform public.rpc__emit_ops_issue(
        v_run_id, v_status, v_cat,
        'Duplicate bars detected',
        'Duplicate (symbol,timeframe,ts) rows found within scan window',
        '{}'::jsonb, v_check
      );
    end if;

    v_rank := public.rpc__severity_rank(v_status);
    if v_rank > v_overall_rank then v_overall := v_status; v_overall_rank := v_rank; end if;
    v_total_issues := v_total_issues + v_issue_count;
  end if;

  -- ===============================================================
  -- Final worker health record
  -- ===============================================================
  v_finished := clock_timestamp();

  insert into public.quality_workerhealth (
    worker_name, run_id, trigger, mode,
    started_at, finished_at, duration_ms,
    status, checks_run, issue_count,
    checkpoints, metrics, error_detail
  ) values (
    'data_validation_worker',
    v_run_id,
    v_trigger,
    v_mode,
    v_started,
    v_finished,
    round(extract(epoch from (v_finished - v_started))*1000,2),
    v_overall,
    v_checks_run,
    v_total_issues,
    jsonb_build_object('persisted_results', true),
    jsonb_build_object('checks_run', v_checks_run, 'issue_count', v_total_issues),
    '{}'::jsonb
  );

  return jsonb_build_object(
    'env_name', p_env_name,
    'run_id', v_run_id,
    'mode', v_mode,
    'trigger', v_trigger,
    'overall_status', v_overall,
    'checks_run', v_checks_run,
    'issue_count', v_total_issues,
    'execution_time_ms',
      round(extract(epoch from (v_finished - v_started))*1000,2),
    'checks', v_checks
  );

exception when others then
  v_finished := clock_timestamp();

  insert into public.quality_workerhealth (
    worker_name, run_id, trigger, mode,
    started_at, finished_at, duration_ms,
    status, checks_run, issue_count,
    checkpoints, metrics, error_detail
  ) values (
    'data_validation_worker',
    v_run_id,
    v_trigger,
    v_mode,
    v_started,
    v_finished,
    round(extract(epoch from (v_finished - v_started))*1000,2),
    'error',
    v_checks_run,
    v_total_issues,
    jsonb_build_object('persisted_results', false),
    jsonb_build_object('checks_run', v_checks_run, 'issue_count', v_total_issues),
    jsonb_build_object('error_detail', sqlstate || ': ' || sqlerrm)
  );

  perform public.rpc__emit_ops_issue(
    v_run_id,
    'error',
    'orchestrator',
    'Health check orchestrator failed',
    'Orchestrator exception occurred',
    '{}'::jsonb,
    jsonb_build_object('sqlstate',sqlstate,'sqlerrm',sqlerrm)
  );

  return jsonb_build_object(
    'env_name', coalesce(p_env_name,''),
    'run_id', v_run_id,
    'mode', v_mode,
    'trigger', v_trigger,
    'overall_status', 'error',
    'checks_run', v_checks_run,
    'issue_count', v_total_issues,
    'execution_time_ms',
      round(extract(epoch from (v_finished - v_started))*1000,2),
    'error_message', 'orchestrator failed',
    'error_detail', sqlstate || ': ' || sqlerrm,
    'checks', coalesce(v_checks,'[]'::jsonb)
  );
end;
$$;

revoke all on function public.rpc_run_health_checks(text,text,text) from public;
grant execute on function public.rpc_run_health_checks(text,text,text) to service_role;
