-- =====================================================================
--  أتوبيس الخير — جمعية القوافل للمساعدات الإنسانية
--  قاعدة البيانات (Supabase / Postgres)
--  شغّل الملف ده كله مرة واحدة من: Supabase → SQL Editor → New query
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- المستخدمين (أدمن / مشرف) ----------
create table if not exists public.profiles (
  id            uuid primary key references auth.users on delete cascade,
  username      text unique not null,
  full_name     text not null,
  role          text not null default 'supervisor' check (role in ('admin','supervisor')),
  active        boolean not null default true,
  tg_chat_id    bigint,
  tg_link_token text unique not null default encode(gen_random_bytes(8),'hex'),
  created_at    timestamptz not null default now()
);

-- ---------- الباصات ----------
create table if not exists public.buses (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,
  capacity  int  not null default 28 check (capacity > 0),
  active    boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- الطلاب ----------
create sequence if not exists public.student_code_seq start 1001;

create table if not exists public.students (
  id                uuid primary key default gen_random_uuid(),
  code              int  unique not null default nextval('public.student_code_seq'),
  qr_token          text unique not null default encode(gen_random_bytes(6),'hex'),
  full_name         text not null,
  photo_url         text,
  phone             text,
  parent_name       text,
  parent_phone      text,
  address           text,
  bus_id            uuid references public.buses on delete set null,
  days              smallint[] not null default '{}',   -- 0=الأحد … 6=السبت
  suspended         boolean not null default false,
  suspend_reason    text,
  parent_chat_id    bigint,
  parent_link_token text unique not null default encode(gen_random_bytes(6),'hex'),
  notes             text,
  created_at        timestamptz not null default now()
);
create index if not exists students_bus_idx on public.students(bus_id);

-- ---------- الرحلات (رحلة ذهاب/عودة لكل باص في اليوم) ----------
create table if not exists public.trips (
  id              uuid primary key default gen_random_uuid(),
  bus_id          uuid not null references public.buses on delete cascade,
  kind            text not null check (kind in ('go','back')),
  trip_date       date not null,
  supervisor_id   uuid references public.profiles on delete set null,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  absent_notified boolean not null default false,
  unique (bus_id, trip_date, kind)
);

-- ---------- الركوب (مقبول فقط) ----------
create table if not exists public.rides (
  id          bigserial primary key,
  trip_id     uuid not null references public.trips on delete cascade,
  student_id  uuid not null references public.students on delete cascade,
  scanned_by  uuid references public.profiles on delete set null,
  scanned_at  timestamptz not null default now(),
  unique (trip_id, student_id)
);

-- ---------- محاولات مرفوضة (مش يومه، موقوف، باص كامل...) ----------
create table if not exists public.scan_log (
  id          bigserial primary key,
  trip_id     uuid references public.trips on delete cascade,
  student_id  uuid references public.students on delete cascade,
  result      text not null,
  scanned_by  uuid references public.profiles on delete set null,
  scanned_at  timestamptz not null default now()
);

-- =====================================================================
--  دوال مساعدة
-- =====================================================================
create or replace function public.cairo_today() returns date
language sql stable as $$ select (now() at time zone 'Africa/Cairo')::date $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and role = 'admin' and active)
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = auth.uid() and active)
$$;

-- =====================================================================
--  صلاحيات الجداول (RLS)
--  المشرف مش بيشوف بيانات الطلاب (عناوين/أرقام) — بيوصل للمسح بس عن طريق الدوال
-- =====================================================================
alter table public.profiles enable row level security;
alter table public.buses    enable row level security;
alter table public.students enable row level security;
alter table public.trips    enable row level security;
alter table public.rides    enable row level security;
alter table public.scan_log enable row level security;

drop policy if exists p_profiles_read  on public.profiles;
drop policy if exists p_profiles_admin on public.profiles;
create policy p_profiles_read  on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy p_profiles_admin on public.profiles for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists p_buses_read  on public.buses;
drop policy if exists p_buses_admin on public.buses;
create policy p_buses_read  on public.buses for select using (public.is_staff());
create policy p_buses_admin on public.buses for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists p_students_admin on public.students;
create policy p_students_admin on public.students for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists p_trips_read  on public.trips;
drop policy if exists p_trips_admin on public.trips;
create policy p_trips_read  on public.trips for select using (public.is_staff());
create policy p_trips_admin on public.trips for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists p_rides_read  on public.rides;
drop policy if exists p_rides_admin on public.rides;
create policy p_rides_read  on public.rides for select using (public.is_staff());
create policy p_rides_admin on public.rides for delete using (public.is_admin());

drop policy if exists p_log_admin on public.scan_log;
create policy p_log_admin on public.scan_log for select using (public.is_admin());

-- =====================================================================
--  بدء رحلة (لو فيه رحلة لنفس الباص والنوع النهارده يرجّعها — مشرفين أكتر من واحد يشتغلوا عليها)
-- =====================================================================
create or replace function public.start_trip(p_bus uuid, p_kind text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t trips; b buses;
begin
  if not is_staff() then raise exception 'غير مسموح'; end if;
  select * into b from buses where id = p_bus and active;
  if b.id is null then raise exception 'الباص غير موجود'; end if;

  insert into trips(bus_id, kind, trip_date, supervisor_id)
  values (p_bus, p_kind, cairo_today(), auth.uid())
  on conflict (bus_id, trip_date, kind) do nothing;

  select * into t from trips where bus_id = p_bus and trip_date = cairo_today() and kind = p_kind;
  if t.ended_at is not null then
    -- إعادة فتح رحلة اتقفلت بالغلط
    update trips set ended_at = null where id = t.id returning * into t;
  end if;

  return jsonb_build_object(
    'id', t.id, 'kind', t.kind, 'trip_date', t.trip_date,
    'bus_id', b.id, 'bus_name', b.name, 'capacity', b.capacity,
    'onboard', (select count(*) from rides where trip_id = t.id),
    'expected', (select count(*) from students s
                 where s.bus_id = b.id and not s.suspended
                   and extract(dow from t.trip_date)::int = any(s.days))
  );
end $$;

-- =====================================================================
--  المسح — قلب النظام
--  بيرجّع: ok / not_today / suspended / other_bus / already / full / unknown / trip_closed
-- =====================================================================
create or replace function public.scan_student(p_trip uuid, p_token text default null, p_code int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t trips; b buses; s students; n int; res text; tok text;
begin
  if not is_staff() then raise exception 'غير مسموح'; end if;

  select * into t from trips where id = p_trip for update;  -- قفل الرحلة علشان العدّاد ميزدش لو مشرفين مسحوا في نفس اللحظة
  if t.id is null then raise exception 'الرحلة غير موجودة'; end if;
  if t.ended_at is not null then return jsonb_build_object('status','trip_closed'); end if;
  select * into b from buses where id = t.bus_id;

  if p_token is not null then
    tok := regexp_replace(trim(p_token), '^QB:', '');
    select * into s from students where qr_token = tok;
  elsif p_code is not null then
    select * into s from students where code = p_code;
  end if;

  select count(*) into n from rides where trip_id = t.id;

  if s.id is null then res := 'unknown';
  elsif s.suspended then res := 'suspended';
  elsif s.bus_id is not null and s.bus_id <> t.bus_id then res := 'other_bus';
  elsif not (extract(dow from t.trip_date)::int = any(s.days)) then res := 'not_today';
  elsif exists(select 1 from rides where trip_id = t.id and student_id = s.id) then res := 'already';
  elsif n >= b.capacity then res := 'full';
  else
    insert into rides(trip_id, student_id, scanned_by) values (t.id, s.id, auth.uid());
    n := n + 1; res := 'ok';
  end if;

  if res not in ('ok','already') then
    insert into scan_log(trip_id, student_id, result, scanned_by) values (t.id, s.id, res, auth.uid());
  end if;

  return jsonb_build_object(
    'status', res, 'onboard', n, 'capacity', b.capacity,
    'student', case when s.id is null then null else jsonb_build_object(
       'id', s.id, 'code', s.code, 'name', s.full_name, 'photo', s.photo_url,
       'days', s.days, 'reason', s.suspend_reason) end
  );
end $$;

-- تراجع عن آخر ركوب سجّله نفس المشرف (خلال 15 دقيقة)
create or replace function public.undo_last_ride(p_trip uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r rides; nm text;
begin
  if not is_staff() then raise exception 'غير مسموح'; end if;
  select * into r from rides where trip_id = p_trip and scanned_by = auth.uid()
    and scanned_at > now() - interval '15 minutes' order by scanned_at desc limit 1;
  if r.id is null then return jsonb_build_object('ok', false); end if;
  select full_name into nm from students where id = r.student_id;
  delete from rides where id = r.id;
  return jsonb_build_object('ok', true, 'name', nm,
    'onboard', (select count(*) from rides where trip_id = p_trip));
end $$;

-- قائمة الراكبين في الرحلة (للمشرف)
create or replace function public.trip_riders(p_trip uuid)
returns table(code int, name text, photo text, scanned_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.code, s.full_name, s.photo_url, r.scanned_at
  from rides r join students s on s.id = r.student_id
  where r.trip_id = p_trip and public.is_staff()
  order by r.scanned_at desc
$$;

-- بحث بالاسم أو الكود للمشرف (بدون أرقام أو عناوين)
create or replace function public.find_student(q text)
returns table(code int, name text, photo text)
language sql stable security definer set search_path = public as $$
  select code, full_name, photo_url from students
  where public.is_staff() and (full_name ilike '%'||q||'%' or code::text = q)
  order by full_name limit 8
$$;

-- إنهاء الرحلة
create or replace function public.end_trip(p_trip uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'غير مسموح'; end if;
  update trips set ended_at = now() where id = p_trip and ended_at is null;
end $$;

-- إعادة إصدار الـ QR (الكارت القديم يبطل فورًا)
create or replace function public.reissue_qr(p_student uuid)
returns text language plpgsql security definer set search_path = public as $$
declare tok text;
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  update students set qr_token = encode(gen_random_bytes(6),'hex') where id = p_student returning qr_token into tok;
  return tok;
end $$;

grant execute on function public.start_trip, public.scan_student, public.undo_last_ride,
  public.trip_riders, public.find_student, public.end_trip, public.reissue_qr to authenticated;

-- =====================================================================
--  الصور والكروت (Storage)
-- =====================================================================
insert into storage.buckets (id, name, public) values ('photos','photos', true), ('cards','cards', true)
on conflict (id) do nothing;

drop policy if exists bus_media_read   on storage.objects;
drop policy if exists bus_media_insert on storage.objects;
drop policy if exists bus_media_update on storage.objects;
drop policy if exists bus_media_delete on storage.objects;
create policy bus_media_read   on storage.objects for select to authenticated using (bucket_id in ('photos','cards'));
create policy bus_media_insert on storage.objects for insert to authenticated with check (bucket_id in ('photos','cards') and public.is_admin());
create policy bus_media_update on storage.objects for update to authenticated using (bucket_id in ('photos','cards') and public.is_admin());
create policy bus_media_delete on storage.objects for delete to authenticated using (bucket_id in ('photos','cards') and public.is_admin());

-- باص افتراضي
insert into public.buses(name, capacity)
select 'أتوبيس الخير 1', 28 where not exists (select 1 from public.buses);

-- ===== تحديث 01 =====
alter table public.students add column if not exists photo_file text;

create or replace function public.sync_code_seq() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  perform setval('public.student_code_seq', greatest(coalesce((select max(code) from students), 1000), 1000));
end $$;
grant execute on function public.sync_code_seq to authenticated;

-- ===== تحديث 02 =====
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
