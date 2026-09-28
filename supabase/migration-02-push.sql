-- تحديث 02: إشعارات التطبيق (Web Push)
create table if not exists public.push_subs (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles on delete cascade,
  endpoint   text unique not null,
  p256dh     text not null,
  auth       text not null,
  ua         text,
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
drop policy if exists p_push_own on public.push_subs;
create policy p_push_own on public.push_subs for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- حفظ اشتراك الجهاز (لو نفس الموبايل اتسجل عليه حساب تاني بيتنقل للحساب الجديد)
create or replace function public.save_push_sub(p_endpoint text, p_p256dh text, p_auth text, p_ua text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'غير مسموح'; end if;
  insert into push_subs(user_id, endpoint, p256dh, auth, ua) values (auth.uid(), p_endpoint, p_p256dh, p_auth, p_ua)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua;
end $$;
grant execute on function public.save_push_sub to authenticated;
