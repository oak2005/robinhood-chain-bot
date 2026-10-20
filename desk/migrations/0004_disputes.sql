create table if not exists payment_disputes (
  id text primary key,
  user_id text not null,
  tx_hash text not null,
  chain text not null,
  user_note text not null default '',
  status text not null default 'pending',
  admin_note text not null default '',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists payment_disputes_user_idx on payment_disputes (user_id);
create index if not exists payment_disputes_status_idx on payment_disputes (status);
