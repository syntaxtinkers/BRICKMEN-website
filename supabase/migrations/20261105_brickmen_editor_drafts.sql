-- Brickmen Studio: isolated editor drafts for published projects.
-- Additive only. An admin can edit and save a draft without changing the live page.
alter table public.brickmen_projects
  add column if not exists draft_content jsonb;

comment on column public.brickmen_projects.draft_content is
  'Private working copy of editable project metadata and visibility. Applied to live fields only when the administrator publishes.';
