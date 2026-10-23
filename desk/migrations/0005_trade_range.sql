alter table member_slots add column if not exists trade_range text not null default '5-20';
