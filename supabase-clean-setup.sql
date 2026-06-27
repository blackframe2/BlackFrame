-- BLACKFRAME SUPABASE CLEAN SETUP
-- ADVERTENCIA: este script limpia las tablas publicas y todos los buckets de Storage
-- del proyecto Supabase donde lo ejecutes. Usalo solo en el proyecto nuevo de BlackFrame.

begin;

-- 1) Limpiar tablas publicas del proyecto.
do $$
declare
  table_record record;
begin
  for table_record in
    select schemaname, tablename
    from pg_tables
    where schemaname = 'public'
      and tablename <> 'spatial_ref_sys'
  loop
    execute format('drop table if exists %I.%I cascade', table_record.schemaname, table_record.tablename);
  end loop;
end $$;

-- 2) Limpiar Storage.
delete from storage.objects;
delete from storage.buckets;

-- 3) Estado principal de BlackFrame.
create table public.blackframe_state (
  id text primary key,
  version bigint not null default 0,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.blackframe_state enable row level security;

create policy "BlackFrame public read"
on public.blackframe_state
for select
to anon, authenticated
using (true);

create policy "BlackFrame public insert"
on public.blackframe_state
for insert
to anon, authenticated
with check (id = 'blackframe-main');

create policy "BlackFrame public update"
on public.blackframe_state
for update
to anon, authenticated
using (id = 'blackframe-main')
with check (id = 'blackframe-main');

insert into public.blackframe_state (id, version, data, updated_at)
values (
  'blackframe-main',
  0,
  jsonb_build_object(
    'version', 'supabase-1.0',
    'createdAt', now(),
    'updatedAt', now(),
    'users', '[]'::jsonb,
    'posts', '[]'::jsonb,
    'reels', '[]'::jsonb,
    'conversations', '[]'::jsonb,
    'notifications', '[]'::jsonb,
    'reports', '[]'::jsonb
  ),
  now()
);

-- 4) Bucket publico para imagenes, GIF y videos comprimidos/controlados.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'blackframe-media',
  'blackframe-media',
  true,
  26214400,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "BlackFrame media read" on storage.objects;
drop policy if exists "BlackFrame media insert" on storage.objects;
drop policy if exists "BlackFrame media update" on storage.objects;
drop policy if exists "BlackFrame media delete" on storage.objects;

create policy "BlackFrame media read"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'blackframe-media');

create policy "BlackFrame media insert"
on storage.objects
for insert
to anon, authenticated
with check (bucket_id = 'blackframe-media');

create policy "BlackFrame media update"
on storage.objects
for update
to anon, authenticated
using (bucket_id = 'blackframe-media')
with check (bucket_id = 'blackframe-media');

create policy "BlackFrame media delete"
on storage.objects
for delete
to anon, authenticated
using (bucket_id = 'blackframe-media');

-- 5) Realtime para que likes, posts, comentarios y mensajes aparezcan sin recargar.
alter table public.blackframe_state replica identity full;

do $$
begin
  execute 'alter publication supabase_realtime add table public.blackframe_state';
exception
  when duplicate_object then null;
  when undefined_object then
    raise notice 'La publicacion supabase_realtime no existe todavia. Activa Realtime en Supabase si hiciera falta.';
end $$;

-- 6) Limpieza para no llenar el plan gratis: publicaciones/reels y archivos con mas de 62 dias.
create or replace function public.blackframe_cleanup_old_content()
returns void
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  cutoff timestamptz := now() - interval '62 days';
begin
  update public.blackframe_state as state
  set
    data = jsonb_set(
      jsonb_set(
        state.data,
        '{posts}',
        coalesce((
          select jsonb_agg(post_item.value)
          from jsonb_array_elements(coalesce(state.data->'posts', '[]'::jsonb)) as post_item(value)
          where coalesce((post_item.value->>'createdAt')::timestamptz, now()) >= cutoff
        ), '[]'::jsonb),
        true
      ),
      '{reels}',
      coalesce((
        select jsonb_agg(reel_item.value)
        from jsonb_array_elements(coalesce(state.data->'reels', '[]'::jsonb)) as reel_item(value)
        where coalesce((reel_item.value->>'createdAt')::timestamptz, now()) >= cutoff
      ), '[]'::jsonb),
      true
    ),
    version = state.version + 1,
    updated_at = now()
  where state.id = 'blackframe-main';

  delete from storage.objects
  where bucket_id = 'blackframe-media'
    and created_at < cutoff;
end;
$$;

-- Ejecuta una limpieza ahora mismo.
select public.blackframe_cleanup_old_content();

-- Intenta programar limpieza diaria a las 04:00 UTC. Si pg_cron no esta disponible,
-- la app igual limpia contenido viejo al cargar/guardar.
do $$
begin
  execute 'create extension if not exists pg_cron with schema extensions';
exception
  when others then
    raise notice 'pg_cron no disponible en este proyecto: %', sqlerrm;
end $$;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    begin
      execute 'select cron.unschedule(''blackframe-cleanup-62-days'')';
    exception
      when others then null;
    end;
    execute 'select cron.schedule(''blackframe-cleanup-62-days'', ''0 4 * * *'', ''select public.blackframe_cleanup_old_content();'')';
  else
    raise notice 'No se pudo programar cron; ejecuta manualmente: select public.blackframe_cleanup_old_content();';
  end if;
exception
  when others then
    raise notice 'No se pudo programar la limpieza automatica: %', sqlerrm;
end $$;

commit;
