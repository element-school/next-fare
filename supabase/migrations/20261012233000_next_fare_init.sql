-- Where Next (next-fare): private driving data in the permit-explorer Supabase project,
-- kept apart from permit-explorer's public tables.
-- Nothing in schema next_fare is exposed to the API roles. The phone app writes only through
-- public.nf_log_advice(), which checks a per-device key (stored here only as a SHA-256 hash).

create schema if not exists next_fare;
revoke all on schema next_fare from public, anon, authenticated;

create table next_fare.devices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  key_hash text not null unique,          -- sha256 hex of the device key; the key itself is never stored
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

-- One row per refresh of the app: where the driver was and what the app advised.
create table next_fare.advice_log (
  id bigint generated always as identity primary key,
  device_id uuid not null references next_fare.devices(id),
  client_key text not null,               -- the app's entry key; a recompute in the same refresh updates the row
  t timestamptz not null,
  lat double precision,
  lng double precision,
  action text,
  target text,
  entry jsonb not null,                   -- the full entry as the app recorded it
  received_at timestamptz not null default now(),
  unique (device_id, client_key)
);
create index advice_log_t_idx on next_fare.advice_log (t);

-- Completed Uber trips, loaded from the driver's earnings pages.
create table next_fare.trips (
  trip_id text primary key,
  started_at timestamptz,
  ended_at timestamptz,
  duration_s integer,
  distance_mi numeric,
  product text,
  pickup text,
  dropoff text,
  pickup_lat double precision,
  pickup_lng double precision,
  dropoff_lat double precision,
  dropoff_lng double precision,
  earnings numeric,
  tip numeric,
  rider_fare numeric,
  uber_fee numeric,
  raw jsonb,
  loaded_at timestamptz not null default now()
);
create index trips_started_idx on next_fare.trips (started_at);

alter table next_fare.devices enable row level security;
alter table next_fare.advice_log enable row level security;
alter table next_fare.trips enable row level security;

create or replace function public.nf_log_advice(p_key text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device uuid;
  v_count integer := 0;
begin
  if p_key is null or length(p_key) < 32 then
    raise exception 'invalid key' using errcode = '28000';
  end if;
  select d.id into v_device
    from next_fare.devices d
   where d.key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex')
     and d.revoked_at is null;
  if v_device is null then
    raise exception 'unknown key' using errcode = '28000';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'payload must be an array of at most 500 entries' using errcode = '22023';
  end if;

  insert into next_fare.advice_log (device_id, client_key, t, lat, lng, action, target, entry)
  select v_device,
         r->>'k',
         to_timestamp((r->>'t')::double precision / 1000.0),
         (r->>'lat')::double precision,
         (r->>'lng')::double precision,
         r->>'a',
         r->>'to',
         r
    from jsonb_array_elements(p_rows) as r
   where r ? 'k' and r ? 't'
  on conflict (device_id, client_key) do update
     set t = excluded.t, lat = excluded.lat, lng = excluded.lng,
         action = excluded.action, target = excluded.target,
         entry = excluded.entry, received_at = now();
  get diagnostics v_count = row_count;

  update next_fare.devices set last_seen_at = now() where id = v_device;
  return v_count;
end
$$;

revoke all on function public.nf_log_advice(text, jsonb) from public;
grant execute on function public.nf_log_advice(text, jsonb) to anon, authenticated;

comment on schema next_fare is 'Where Next driving companion (element-school/next-fare): private data, not exposed to the API.';
comment on function public.nf_log_advice(text, jsonb) is 'Where Next: upload advice-log entries from a registered device. Requires the device key.';
