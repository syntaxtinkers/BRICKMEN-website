-- Brickmen editorial page + publish setup.
-- Safe to run even if the draft_content column or public portfolio RPC changes
-- from earlier migrations have already been applied. This does not delete or reset data.

alter table public.brickmen_projects
  add column if not exists draft_content jsonb;

comment on column public.brickmen_projects.draft_content is
  'Private working copy of editable project metadata and visibility. Applied to live fields only when an administrator publishes.';

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
              'id', m.id,
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

comment on function public.brickmen_public_portfolio() is
  'Returns approved published Brickmen pages with only explicitly public media and layout references.';
