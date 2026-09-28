// =====================================================================
//  أتوبيس الخير — إرسال إشعارات التطبيق (Web Push)
//  منفصلة عن bot علشان لو حصلت فيها مشكلة البوت يفضل شغال
//  بتتنادى من function "bot" بس (بمفتاح داخلي)
//  Deploy: اسمها push — و Verify JWT مقفول
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const INTERNAL = Deno.env.get("CRON_SECRET") ?? "";

webpush.setVapidDetails(
  "mailto:" + (Deno.env.get("VAPID_CONTACT") ?? "admin@example.com"),
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

Deno.serve(async (req) => {
  if (!INTERNAL || req.headers.get("x-internal") !== INTERNAL) return new Response("forbidden", { status: 403 });
  const { user_ids, admins, title, body, url, tag } = await req.json();

  let ids: string[] = user_ids ?? [];
  if (admins) {
    const { data } = await db.from("profiles").select("id").eq("role", "admin").eq("active", true);
    ids = [...ids, ...(data ?? []).map((r) => r.id)];
  }
  if (!ids.length) return Response.json({ sent: 0 });

  const { data: subs } = await db.from("push_subs").select("*").in("user_id", ids);
  const payload = JSON.stringify({ title, body, url, tag });
  let sent = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600, urgency: "high" });
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("push_subs").delete().eq("id", s.id); // جهاز اتمسح منه التطبيق
      else console.error("push failed", e?.statusCode, e?.body ?? e?.message);
    }
  }));
  return Response.json({ sent });
});
