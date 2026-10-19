-- Stillmark production schema.
-- Credential material is ciphertext only. The master key lives in KMS, never in this database.

create table users (
  id uuid primary key,
  telegram_user_id text not null unique,
  created_at timestamptz not null default now()
);

create table api_credentials (
  id uuid primary key,
  user_id uuid not null references users (id),
  api_key_tail text not null,
  ciphertext bytea not null,
  nonce bytea not null,
  dek_wrapped bytea not null,
  kms_key_id text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table bot_config (
  user_id uuid primary key references users (id),
  pair text not null,
  interval_key text not null check (interval_key in ('10m', '20m', '30m', '1h')),
  trade_target_usd numeric not null,
  min_protected_usd numeric not null check (min_protected_usd >= 7),
  max_spread_pct numeric not null,
  max_total_cost_pct numeric not null,
  max_market_cost_pct numeric not null,
  dry_run boolean not null default true,
  trading_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table trading_pairs (
  symbol text primary key,
  asset_increment numeric not null,
  quote_increment numeric not null,
  min_order_usd numeric not null,
  is_api_tradable boolean not null
);

create table quotes (
  id bigserial primary key,
  symbol text not null,
  bid numeric not null,
  ask numeric not null,
  observed_at timestamptz not null
);

create table orders (
  id uuid primary key,
  user_id uuid not null references users (id),
  client_order_id uuid not null unique,
  venue_order_id text,
  symbol text not null,
  side text not null check (side in ('buy', 'sell')),
  order_type text not null check (order_type in ('limit', 'market')),
  state text not null,
  requested_notional numeric not null,
  created_at timestamptz not null default now()
);

create table order_fills (
  id uuid primary key,
  order_id uuid not null references orders (id),
  qty numeric not null,
  price numeric not null,
  fee numeric not null,
  filled_at timestamptz not null
);

create table trade_cycles (
  id uuid primary key,
  user_id uuid not null references users (id),
  symbol text not null,
  decision text not null,
  reason text not null,
  sell_order_id uuid references orders (id),
  buy_order_id uuid references orders (id),
  estimated_cost_pct numeric,
  equity_after numeric,
  created_at timestamptz not null default now()
);

create table security_events (
  id bigserial primary key,
  telegram_user_id text,
  kind text not null,
  detail text not null,
  created_at timestamptz not null default now()
);

create table audit_logs (
  id bigserial primary key,
  telegram_user_id text,
  action text not null,
  pair text,
  decision text,
  reason text,
  created_at timestamptz not null default now()
);

create table bot_state (
  user_id uuid primary key references users (id),
  halted boolean not null default true,
  lock_token text,
  last_confirmed_trade_at timestamptz,
  updated_at timestamptz not null default now()
);
