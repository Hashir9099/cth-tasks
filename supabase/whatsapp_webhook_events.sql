-- New table only. Does not alter profiles, tasks, or queries.
-- Run in the Supabase SQL editor (service role bypasses RLS).

create table if not exists public.whatsapp_webhook_events (
  event_key text primary key,
  event_type text not null,
  wa_message_id text,
  wa_status text,
  from_wa_id text,
  message_type text,
  phone_number_id text,
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_webhook_events_wa_message_id_idx
  on public.whatsapp_webhook_events (wa_message_id);

alter table public.whatsapp_webhook_events enable row level security;
