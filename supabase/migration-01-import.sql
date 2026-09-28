-- تحديث 01: استيراد الشيت القديم + رفع الصور بالجملة
-- شغّله مرة واحدة من SQL Editor
alter table public.students add column if not exists photo_file text;

create or replace function public.sync_code_seq() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'غير مسموح'; end if;
  perform setval('public.student_code_seq', greatest(coalesce((select max(code) from students), 1000), 1000));
end $$;
grant execute on function public.sync_code_seq to authenticated;
