create table if not exists member_desks (
  user_id text primary key,
  chain text not null,
  address text not null,
  token text not null,
  symbol text not null default '',
  interval text not null default '30m',
  donation_usd integer not null default 0,
  donation_ref text not null default '',
  paid_until timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists member_vault (
  user_id text primary key references member_desks (user_id) on delete cascade,
  wrapped text not null
);
