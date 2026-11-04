-- Brickmen Studio portfolio CMS.
-- Additive schema: keeps the Drive inventory and existing public website content intact.
-- Projects are drafts by default. Only explicitly published projects and selected media
-- are exposed through the public portfolio RPC.

create table if not exists public.brickmen_studio_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role text not null default 'admin' check (role in ('owner', 'admin')),
  is_active boolean not null default true,
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.brickmen_projects (
  id uuid primary key default gen_random_uuid(),
  drive_folder_id text not null unique,
  slug text not null unique,
  title text not null,
  location text,
  category text,
  project_year integer,
  start_date date,
  description text,
  is_archived boolean not null default false,
  is_published boolean not null default false,
  visibility jsonb not null default
    '{"title":true,"location":true,"category":true,"project_year":true,"start_date":false,"description":true}'::jsonb,
  review_status text not null default 'pending'
    check (review_status in ('pending','approved','rejected')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists brickmen_projects_public_idx
  on public.brickmen_projects (is_published, is_archived, project_year desc);
create index if not exists brickmen_projects_updated_idx
  on public.brickmen_projects (updated_at desc);

create table if not exists public.brickmen_project_media (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.brickmen_projects(id) on delete cascade,
  drive_file_id text not null,
  file_name text not null,
  mime_type text not null,
  media_category text,
  caption text,
  alt_text text,
  sort_order integer not null default 0,
  is_public boolean not null default false,
  private_storage_path text,
  public_storage_path text,
  source_created_time timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, drive_file_id)
);

create index if not exists brickmen_project_media_project_order_idx
  on public.brickmen_project_media (project_id, sort_order);

create table if not exists public.brickmen_portfolio_settings (
  id boolean primary key default true check (id = true),
  auto_scan_enabled boolean not null default true,
  auto_scan_interval_hours integer not null default 24
    check (auto_scan_interval_hours between 6 and 168),
  last_auto_scan_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.brickmen_portfolio_settings (id)
values (true)
on conflict (id) do nothing;

-- Separate private review assets from deliberately published portfolio images.
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('brickmen-studio-private', 'brickmen-studio-private', false, 52428800),
  ('brickmen-portfolio-public', 'brickmen-portfolio-public', true, 52428800)
on conflict (id) do nothing;

alter table public.brickmen_studio_admins enable row level security;
alter table public.brickmen_projects enable row level security;
alter table public.brickmen_project_media enable row level security;
alter table public.brickmen_portfolio_settings enable row level security;

revoke all on public.brickmen_studio_admins from anon, authenticated;
revoke all on public.brickmen_projects from anon, authenticated;
revoke all on public.brickmen_project_media from anon, authenticated;
revoke all on public.brickmen_portfolio_settings from anon, authenticated;

grant all on public.brickmen_studio_admins to service_role;
grant all on public.brickmen_projects to service_role;
grant all on public.brickmen_project_media to service_role;
grant all on public.brickmen_portfolio_settings to service_role;

-- Convert every active detected Drive candidate into a private draft exactly once.
-- ON CONFLICT DO NOTHING deliberately preserves admin edits and publication settings.
create or replace function public.brickmen_sync_candidates_to_projects()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  synced_count integer := 0;
begin
  insert into public.brickmen_projects (
    drive_folder_id, slug, title, start_date, is_archived, is_published, review_status
  )
  select
    c.drive_folder_id,
    left(trim(both '-' from regexp_replace(lower(coalesce(nullif(c.ai_title,''), c.name)), '[^a-z0-9]+', '-', 'g')), 70)
      || '-' || left(md5(c.drive_folder_id), 6),
    coalesce(nullif(c.ai_title,''), c.name),
    c.earliest_file_created_at::date,
    c.is_archived,
    false,
    'pending'
  from public.brickmen_drive_project_candidates c
  where c.is_active = true
  on conflict (drive_folder_id) do nothing;

  get diagnostics synced_count = row_count;
  return synced_count;
end;
$$;

revoke all on function public.brickmen_sync_candidates_to_projects() from public, anon, authenticated;
grant execute on function public.brickmen_sync_candidates_to_projects() to service_role;

-- The public website can read only published project fields and explicitly selected
-- media paths. Drafts, hidden photos, private storage paths and Drive identifiers never
-- leave this function.
create or replace function public.brickmen_public_portfolio()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_agg(project_json order by project_year desc nulls last, title asc),
    '[]'::jsonb
  )
  from (
    select
      jsonb_build_object(
        'slug', p.slug,
        'title', case when coalesce((p.visibility->>'title')::boolean, true) then p.title else null end,
        'location', case when coalesce((p.visibility->>'location')::boolean, true) then p.location else null end,
        'category', case when coalesce((p.visibility->>'category')::boolean, true) then p.category else null end,
        'project_year', case when coalesce((p.visibility->>'project_year')::boolean, true) then p.project_year else null end,
        'start_date', case when coalesce((p.visibility->>'start_date')::boolean, false) then p.start_date else null end,
        'description', case when coalesce((p.visibility->>'description')::boolean, true) then p.description else null end,
        'is_archived', p.is_archived,
        'media', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'url', '/storage/v1/object/public/brickmen-portfolio-public/' || m.public_storage_path,
              'category', m.media_category,
              'caption', m.caption,
              'alt_text', m.alt_text,
              'sort_order', m.sort_order
            ) order by m.sort_order, m.created_at
          )
          from public.brickmen_project_media m
          where m.project_id = p.id
            and m.is_public = true
            and m.public_storage_path is not null
        ), '[]'::jsonb)
      ) as project_json,
      p.project_year,
      p.title
    from public.brickmen_projects p
    where p.is_published = true
      and p.review_status = 'approved'
  ) published;
$$;

revoke all on function public.brickmen_public_portfolio() from public;
grant execute on function public.brickmen_public_portfolio() to anon, authenticated, service_role;

comment on table public.brickmen_projects is
  'Brickmen portfolio CMS. Every imported project starts private and unpublished.';
comment on table public.brickmen_project_media is
  'Per-file publication controls. Only copied files in the public portfolio bucket can be exposed.';
comment on table public.brickmen_studio_admins is
  'Invite-only Brickmen Studio administrator accounts and roles.';
