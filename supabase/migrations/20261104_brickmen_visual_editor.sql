-- Brickmen visual portfolio editor foundation.
-- Run AFTER 20261105_brickmen_portfolio_cms.sql.
-- Additive only: preserves existing projects, media, Drive inventory and publication decisions.

alter table public.brickmen_projects
  add column if not exists cover_media_id uuid,
  add column if not exists public_sort_order integer not null default 0,
  add column if not exists published_at timestamptz,
  add column if not exists page_layout_version integer not null default 1;

alter table public.brickmen_project_media
  add column if not exists is_cover boolean not null default false,
  add column if not exists crop jsonb not null default '{"x":0,"y":0,"width":100,"height":100,"fit":"cover"}'::jsonb,
  add column if not exists image_adjustments jsonb not null default '{"brightness":100,"contrast":100,"saturation":100,"grayscale":0,"blur":0} '::jsonb,
  add column if not exists layout jsonb not null default '{"x":0,"y":0,"width":12,"height":8,"rotation":0,"zIndex":1}'::jsonb,
  add column if not exists is_hidden boolean not null default false;

create table if not exists public.brickmen_project_layouts (
  project_id uuid primary key references public.brickmen_projects(id) on delete cascade,
  grid_size_mm numeric(5,2) not null default 5 check (grid_size_mm = 5),
  canvas jsonb not null default '{"width":240,"columns":48,"unit":"grid"}'::jsonb,
  draft_layout jsonb not null default '{"version":1,"elements":[]}'::jsonb,
  published_layout jsonb not null default '{"version":1,"elements":[]}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists brickmen_projects_public_order_idx
  on public.brickmen_projects (is_published, public_sort_order, project_year desc nulls last);

alter table public.brickmen_project_layouts enable row level security;
revoke all on public.brickmen_project_layouts from anon, authenticated;
grant all on public.brickmen_project_layouts to service_role;

-- Only deliberately public media may be returned. Layout and image adjustments are
-- presentation metadata; source Drive files and private storage paths remain private.
create or replace function public.brickmen_public_portfolio()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_agg(project_json order by public_sort_order asc, project_year desc nulls last, title asc),
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
        'layout', coalesce(l.published_layout, '{"version":1,"elements":[]}'::jsonb),
        'media', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'url', '/storage/v1/object/public/brickmen-portfolio-public/' || m.public_storage_path,
              'category', m.media_category,
              'caption', m.caption,
              'alt_text', m.alt_text,
              'sort_order', m.sort_order,
              'is_cover', m.is_cover,
              'crop', m.crop,
              'image_adjustments', m.image_adjustments,
              'layout', m.layout
            ) order by m.is_cover desc, m.sort_order, m.created_at
          )
          from public.brickmen_project_media m
          where m.project_id = p.id
            and m.is_public = true
            and m.is_hidden = false
            and m.public_storage_path is not null
        ), '[]'::jsonb)
      ) as project_json,
      p.project_year,
      p.title,
      p.public_sort_order
    from public.brickmen_projects p
    left join public.brickmen_project_layouts l on l.project_id = p.id
    where p.is_published = true
      and p.review_status = 'approved'
  ) published;
$$;

revoke all on function public.brickmen_public_portfolio() from public;
grant execute on function public.brickmen_public_portfolio() to anon, authenticated, service_role;

comment on table public.brickmen_project_layouts is
  'Admin-managed project page layouts. 5mm logical grid, with separate draft and published layouts.';
