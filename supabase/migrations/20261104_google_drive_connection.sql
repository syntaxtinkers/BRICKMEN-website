-- Brickmen Studio: secure storage for the single authorised Google Drive account.
-- Additive migration: creates one new table and does not modify or delete existing data.
create table if not exists public.brickmen_google_drive_connection (
  id boolean primary key default true check (id = true),
  connected_email text not null,
  granted_scopes text[] not null default '{}',
  refresh_token_ciphertext text not null,
  refresh_token_iv text not null,
  refresh_token_tag text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.brickmen_google_drive_connection is
  'Private Brickmen Studio Google Drive OAuth connection. Refresh tokens are encrypted by the Vercel backend before storage.';
alter table public.brickmen_google_drive_connection enable row level security;
revoke all on table public.brickmen_google_drive_connection from anon, authenticated;
grant all on table public.brickmen_google_drive_connection to service_role;