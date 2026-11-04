-- Brickmen Studio: identify project roots by folder name at any Drive depth.
-- Additive and non-destructive: Drive inventory rows and Google Drive files are untouched.
-- Previously listed internal folders are retained as inactive historical candidates.

alter table public.brickmen_drive_project_candidates
  add column if not exists is_active boolean not null default true;

create index if not exists brickmen_drive_candidates_active_idx
  on public.brickmen_drive_project_candidates (is_active, earliest_file_created_at desc);

create or replace function public.brickmen_build_drive_project_candidates()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer := 0;
begin
  update public.brickmen_drive_project_candidates
     set is_active = false,
         updated_at = now()
   where is_active = true;

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
  ),
  eligible_folders as (
    -- First meaningful folder name at any depth is treated as the project.
    -- Generic Drive containers and architectural subfolders are not projects.
    select
      fp.drive_file_id,
      fp.name,
      fp.parent_folder_id,
      fp.folder_path,
      fp.path_ids,
      stats.earliest_file_created_at,
      coalesce(direct_stats.direct_file_count, 0) as direct_file_count,
      stats.descendant_file_count
    from folder_paths fp
    join stats on stats.drive_folder_id = fp.drive_file_id
    left join direct_stats on direct_stats.drive_folder_id = fp.drive_file_id
    where lower(regexp_replace(trim(fp.name), '[[:space:]]+', ' ', 'g')) <> all (array[
      'projects', 'project', 'project folders', 'project files',
      'client projects', 'client folders', 'clients', 'client archive',
      'clients archive', 'active projects', 'current projects',
      'completed projects', 'ongoing projects', 'upcoming projects',
      'archived projects', 'old projects', 'project archive',
      'project archives', 'residential projects', 'commercial projects',
      'interior projects', 'architecture projects', 'architectural projects',
      'design projects', 'hospitality projects', 'institutional projects',
      'current work', 'active work', 'past work', 'completed work',
      'ongoing work', 'client work', 'work projects',
      'brickmen', 'brickmen studio', 'my drive', 'shared drives',
      'shared', 'drive', 'root', 'google drive',
      'archive', 'archives', 'archived', 'old', 'old files',
      'backup', 'backups', 'temporary', 'temp', 'misc', 'miscellaneous',
      'drawings', 'drawing', 'photos', 'photo', 'photographs',
      'images', 'image', 'pictures', 'plans', 'plan', 'floor plans',
      'sections', 'elevations', 'details', 'interiors', 'interior',
      'exteriors', 'exterior', 'renders', 'render', 'renderings',
      'rendering', '3d', '3d views', 'models', 'model',
      'documents', 'document', 'references', 'reference', 'resources',
      'assets', 'site photos', 'site', 'site visits', 'working files',
      'working', 'files', 'presentation', 'presentations',
      'concept', 'concepts', 'design development', 'construction',
      'tender', 'estimates', 'schedule', 'schedules', 'materials',
      'moodboard', 'mood boards', 'inspiration', 'furniture', 'lighting',
      'kitchen', 'bathroom', 'bedroom', 'living', 'ground floor',
      'first floor', 'second floor', 'third floor', 'basement',
      'roof', 'terrace', 'landscape', 'landscaping', 'residential',
      'commercial', 'hospitality', 'institutional', 'office',
      'staff', 'employees', 'admin', 'administration', 'accounts',
      'finance', 'marketing', 'social media', 'website', 'branding',
      'brand', 'personal', 'new folder', 'untitled folder',
      'sample', 'test', 'tests', 'people', 'team', 'employee folders',
      'year wise', 'by year', '2020s'
    ]::text[])
      and lower(trim(fp.name)) !~ '^(19|20)[0-9]{2}$'
      and lower(trim(fp.name)) !~ '^(all|active|current|completed|ongoing|upcoming|archived|archive|old|my|our|residential|commercial|interior|architecture|architectural|design|building|hospitality|institutional|landscape|house|villa)[[:space:]_-]+(projects?|clients?|work)$'
  ),
  project_roots as (
    -- Suppress descendants of a meaningful folder so Drawings, Photos,
    -- Renders, etc. stay grouped inside their parent project.
    select candidate.*
    from eligible_folders candidate
    where not exists (
      select 1
      from eligible_folders ancestor
      where cardinality(candidate.path_ids) > 1
        and ancestor.drive_file_id = any(
          candidate.path_ids[1:cardinality(candidate.path_ids) - 1]
        )
    )
  )
  insert into public.brickmen_drive_project_candidates (
    drive_folder_id, name, parent_folder_id, folder_path,
    earliest_file_created_at, direct_file_count, descendant_file_count,
    is_archived, is_active, last_scanned_at, updated_at
  )
  select
    project_roots.drive_file_id,
    project_roots.name,
    project_roots.parent_folder_id,
    project_roots.folder_path,
    project_roots.earliest_file_created_at,
    project_roots.direct_file_count,
    project_roots.descendant_file_count,
    lower(project_roots.folder_path) ~ '(^|[ /])(archive|archives|archived|old projects)([ /]|$)',
    true,
    now(),
    now()
  from project_roots
  on conflict (drive_folder_id) do update set
    name = excluded.name,
    parent_folder_id = excluded.parent_folder_id,
    folder_path = excluded.folder_path,
    earliest_file_created_at = excluded.earliest_file_created_at,
    direct_file_count = excluded.direct_file_count,
    descendant_file_count = excluded.descendant_file_count,
    is_archived = excluded.is_archived,
    is_active = true,
    last_scanned_at = now(),
    updated_at = now();

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on function public.brickmen_build_drive_project_candidates() from public, anon, authenticated;
grant execute on function public.brickmen_build_drive_project_candidates() to service_role;

-- Rebuild immediately from existing Drive metadata; no Drive rescan is required.
select public.brickmen_build_drive_project_candidates();

update public.brickmen_drive_scan_state
   set candidate_folders = (
     select count(*)
     from public.brickmen_drive_project_candidates
     where is_active = true
   ),
   updated_at = now()
 where id = true;
