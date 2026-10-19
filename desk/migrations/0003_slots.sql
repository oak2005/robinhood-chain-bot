create table if not exists member_access (
  user_id text primary key,
  memo text not null unique,
  paid_until timestamptz,
  last_tx text not null default ''
);

create table if not exists member_slots (
  id text primary key,
  user_id text not null,
  chain text not null,
  address text not null,
  token text not null,
  symbol text not null default '',
  interval text not null default '30m',
  created_at timestamptz not null default now()
);

create unique index if not exists member_slots_token_idx on member_slots (user_id, chain, token);

create table if not exists member_slot_vault (
  slot_id text primary key references member_slots (id) on delete cascade,
  wrapped text not null
);

create table if not exists used_payments (
  tx_hash text primary key,
  user_id text not null,
  pay_chain text not null,
  asset text not null,
  amount text not null
);
