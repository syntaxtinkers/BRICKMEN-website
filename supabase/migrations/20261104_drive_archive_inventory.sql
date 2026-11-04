-- Brickmen Studio: read-only Google Drive inventory and project-folder review queue.
-- Additive only: preserves the OAuth connection and all existing website content.
create table if not exists public.brickmen_drive_items (
  drive_file_id text primary key,
  name text not null,
  mime_type text not null,
  parent_ids text[] not null default '{}',
  created_time timestamptz,
  modified_time timestamptz,
  web_view_link text,
  thumbnail_link text,
  size_bytes bigint,
  md5_checksum text,
  description text,
  drive_id text,
  is_folder boolean not null default false,
  last_seen_at timestamptz not null default now()
);

create index if not exists brickmen_drive_items_mime_idx
  on public.brickmen_drive_items (mime_type);
create index if not exists brickmen_drive_items_parents_idx
  on public.brickmen_drive_items using gin (parent_ids);
create index if not exists brickmen_drive_items_last_seen_idx
  on public.brickmen_drive_items (last_seen_at desc);

create table if not exists public.brickmen_drive_scan_state (
  id boolean primary key default true check (id = true),
  status text not null default 'idle'
    check (status in ('idle', 'scanning', 'completed', 'error')),
  page_token text,
  scanned_files bigint not null default 0,
  scanned_folders bigint not null default 0,
  candidate_folders bigint not null default 0,
  incomplete_search boolean not null default false,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create table if not exists public.brickmen_drive_project_candidates (
  drive_folder_id text primary key,
  name text not null,
  parent_folder_id text,
  folder_path text not null,
  earliest_file_created_at timestamptz,
  direct_file_count integer not null default 0,
  descendant_file_count integer not null default 0,
  is_archived boolean not null default false,
  ai_title text,
  ai_description text,
  ai_categories text[] not null default '{}',
  ai_confidence numeric(4,3),
  review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'rejected')),
  last_scanned_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists brickmen_drive_candidates_review_idx
  on public.brickmen_drive_project_candidates (review_status, earliest_file_created_at desc);
create index if not exists brickmen_drive_candidates_archived_idx
  on public.brickmen_drive_project_candidates (is_archived, earliest_file_created_at desc);

alter table public.brickmen_drive_items enable row level security;
alter table public.brickmen_drive_scan_state enable row level security;
alter table public.brickmen_drive_project_candidates enable row level security;

revoke all on table public.brickmen_drive_items from anon, authenticated;
revoke all on table public.brickmen_drive_scan_state from anon, authenticated;
revoke all on table public.brickmen_drive_project_candidates from anon, authenticated;
grant all on table public.brickmen_drive_items to service_role;
grant all on table public.brickmen_drive_scan_state to service_role;
grant all on table public.brickmen_drive_project_candidates to service_role;

-- Build candidate project folders from the read-only Drive metadata inventory.
-- Generic organisational folders are skipped, while project folders nested
-- inside archive folders remain candidates and are flagged as archived.
create or replace function public.brickmen_build_drive_project_candidates()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer := 0;
begin
  with recursive folder_paths as (
    select
      f.drive_file_id,
      f.name,
      f.parent_ids[1] as parent_folder_id,
      f.name::text as folder_path,
      array[f.drive_file_id]::text[] as path_ids
    from public.brickmen_drive_items f
    where f.is_folder
      and (
        coalesce(cardinality(f.parent_ids), 0) = 0
        or not exists (
          select 1
          from unnest(f.parent_ids) as u(parent_id)
          join public.brickmen_drive_items p
            on p.drive_file_id = u.parent_id
           and p.is_folder
        )
      )
    union all
    select
      child.drive_file_id,
      child.name,
      parent.drive_file_id as parent_folder_id,
      parent.folder_path || ' / ' || child.name as folder_path,
      parent.path_ids || child.drive_file_id
    from folder_paths parent
    join public.brickmen_drive_items child
      on child.is_folder
     and parent.drive_file_id = any(child.parent_ids)
    where not child.drive_file_id = any(parent.path_ids)
  ),
  file_ancestors as (
    select
      f.drive_file_id as file_id,
      f.created_time,
      u.parent_id as ancestor_id,
      array[u.parent_id]::text[] as path_ids
    from public.brickmen_drive_items f
    cross join unnest(f.parent_ids) as u(parent_id)
    where not f.is_folder
    union all
    select
      fa.file_id,
      fa.created_time,
      u.parent_id as ancestor_id,
      fa.path_ids || u.parent_id
    from file_ancestors fa
    join public.brickmen_drive_items parent
      on parent.drive_file_id = fa.ancestor_id
     and parent.is_folder
    cross join unnest(parent.parent_ids) as u(parent_id)
    where not u.parent_id = any(fa.path_ids)
  ),
  stats as (
    select
      ancestor_id as drive_folder_id,
      count(distinct file_id)::integer as descendant_file_count,
      min(created_time) as earliest_file_created_at
    from file_ancestors
    group by ancestor_id
  ),
  direct_stats as (
    select
      u.parent_id as drive_folder_id,
      count(*)::integer as direct_file_count
    from public.brickmen_drive_items f
    cross join unnest(f.parent_ids) as u(parent_id)
    where not f.is_folder
    group by u.parent_id
  )
  insert into public.brickmen_drive_project_candidates (
    drive_folder_id, name, parent_folder_id, folder_path,
    earliest_file_created_at, direct_file_count, descendant_file_count,
    is_archived, last_scanned_at, updated_at
  )
  select
    fp.drive_file_id,
    fp.name,
    fp.parent_folder_id,
    fp.folder_path,
    stats.earliest_file_created_at,
    coalesce(direct_stats.direct_file_count, 0),
    stats.descendant_file_count,
    lower(fp.folder_path) ~ '(^|[ /])(archive|archives|archived|old projects)([ /]|$)',
    now(),
    now()
  from folder_paths fp
  join stats on stats.drive_folder_id = fp.drive_file_id
  left join direct_stats on direct_stats.drive_folder_id = fp.drive_file_id
  where lower(trim(fp.name)) <> all (array[
    'projects', 'project folders',
    'brickmen', 'my drive', 'shared drives', 'root',
    'drawings', 'photos', 'photographs', 'plans', 'sections',
    'interiors', 'exteriors', 'renders', 'documents', 'references',
    'resources', 'site photos', '3d views', 'working files'
  ]::text[])
  on conflict (drive_folder_id) do update set
    name = excluded.name,
    parent_folder_id = excluded.parent_folder_id,
    folder_path = excluded.folder_path,
    earliest_file_created_at = excluded.earliest_file_created_at,
    direct_file_count = excluded.direct_file_count,
    descendant_file_count = excluded.descendant_file_count,
    is_archived = excluded.is_archived,
    last_scanned_at = now(),
    updated_at = now();

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on function public.brickmen_build_drive_project_candidates() from public, anon, authenticated;
grant execute on function public.brickmen_build_drive_project_candidates() to service_role;
