-- Настройка базы для сайта учителя. Выполнить целиком: Supabase → SQL Editor → New query → Run.
-- Скрипт можно запускать повторно.

-- 1. Содержимое сайта: одна строка id = 1
create table if not exists public.site_content (
  id integer primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 2. Администраторы
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- 3. Проверка прав
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- 4. Защита строк (RLS): читать всем, писать только администратору
alter table public.site_content enable row level security;
alter table public.admins enable row level security;

drop policy if exists "site_content read" on public.site_content;
create policy "site_content read" on public.site_content
  for select to anon, authenticated using (true);

drop policy if exists "site_content insert" on public.site_content;
create policy "site_content insert" on public.site_content
  for insert to authenticated with check (public.is_admin());

drop policy if exists "site_content update" on public.site_content;
create policy "site_content update" on public.site_content
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins read own" on public.admins;
create policy "admins read own" on public.admins
  for select to authenticated using (user_id = auth.uid());

grant select on public.site_content to anon, authenticated;
grant insert, update on public.site_content to authenticated;
grant select on public.admins to authenticated;

-- Пустая строка: пока она пустая, сайт показывает content/default.json
insert into public.site_content (id, data) values (1, '{}'::jsonb) on conflict (id) do nothing;

-- 5. Хранилище фото, видео и файлов: bucket "media"
insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', true, 52428800)
on conflict (id) do update set public = true, file_size_limit = 52428800;

drop policy if exists "media read" on storage.objects;
create policy "media read" on storage.objects
  for select to anon, authenticated using (bucket_id = 'media');

drop policy if exists "media insert" on storage.objects;
create policy "media insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'media' and public.is_admin());

drop policy if exists "media update" on storage.objects;
create policy "media update" on storage.objects
  for update to authenticated using (bucket_id = 'media' and public.is_admin());

drop policy if exists "media delete" on storage.objects;
create policy "media delete" on storage.objects
  for delete to authenticated using (bucket_id = 'media' and public.is_admin());

-- 6. После создания пользователя (Authentication → Users → Add user) выполните,
--    подставив свой e-mail:
-- insert into public.admins (user_id) select id from auth.users where email = 'почта@example.ru';
