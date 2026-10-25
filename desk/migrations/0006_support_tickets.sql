create table if not exists support_tickets (
  id text primary key,
  user_id text not null,
  username text not null default '',
  category text not null default 'issue',
  message text not null,
  status text not null default 'open',
  admin_reply text not null default '',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists support_tickets_user_idx on support_tickets (user_id);
create index if not exists support_tickets_status_idx on support_tickets (status);
