// =====================================================================
//  أتوبيس الخير — Edge Function واحدة بتعمل كل حاجة على السيرفر:
//   1) بوت تليجرام (ربط ولي الأمر / ربط الأدمن / أوامر /today /find)
//   2) إشعار الغياب لولي الأمر بعد إنهاء رحلة الذهاب
//   3) تقرير آخر اليوم للأدمن (بيتنادى من pg_cron)
//   4) إنشاء مشرفين وتغيير الـ PIN (محتاج service role فمكانه هنا)
//  Deploy:  supabase functions deploy bot --no-verify-jwt
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TG_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ORG = Deno.env.get("ORG_NAME") ?? "أتوبيس الخير — جمعية القوافل";
const EMAIL_DOMAIN = "bus.local";

const db = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "content-type": "application/json" } });

const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const KIND: Record<string, string> = { go: "ذهاب", back: "عودة" };
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cairoDate = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
const cairoTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("ar-EG", { timeZone: "Africa/Cairo", hour: "numeric", minute: "2-digit" }) : "—";
const dowOf = (date: string) => new Date(date + "T12:00:00Z").getUTCDay();

async function tg(chat_id: number | string, text: string) {
  if (!BOT) return false;
  const r = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  return r.ok;
}

// إشعار على التطبيق (function "push" منفصلة) — أي فشل هنا مش بيوقف البوت
async function push(msg: { user_ids?: string[]; admins?: boolean; title: string; body: string; tag?: string; url?: string }) {
  try {
    const r = await fetch(`${SB_URL}/functions/v1/push`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal": CRON_SECRET, Authorization: `Bearer ${SERVICE}` },
      body: JSON.stringify(msg),
    });
    return r.ok ? (await r.json()).sent ?? 0 : 0;
  } catch (_) { return 0; }
}

async function adminChats(): Promise<number[]> {
  const { data } = await db.from("profiles").select("tg_chat_id").eq("role", "admin").eq("active", true).not("tg_chat_id", "is", null);
  return (data ?? []).map((r) => r.tg_chat_id);
}

// ---------------------------------------------------------------------
//  الغياب: طالب يومه النهارده، مش موقوف، على الباص ده، ومفيش له ركوب في رحلة الذهاب
// ---------------------------------------------------------------------
async function absentees(trip: any) {
  const dow = dowOf(trip.trip_date);
  const { data: studs } = await db.from("students")
    .select("id, code, full_name, parent_phone, parent_chat_id")
    .eq("bus_id", trip.bus_id).eq("suspended", false).contains("days", [dow]);
  const { data: rides } = await db.from("rides").select("student_id").eq("trip_id", trip.id);
  const rode = new Set((rides ?? []).map((r) => r.student_id));
  return (studs ?? []).filter((s) => !rode.has(s.id));
}

async function notifyAbsence(trip: any) {
  const list = await absentees(trip);
  const out = [];
  for (const s of list) {
    let sent = false;
    if (s.parent_chat_id) {
      sent = await tg(s.parent_chat_id,
        `🚌 <b>${esc(ORG)}</b>\nنحيطكم علمًا أن <b>${esc(s.full_name)}</b> لم يركب الأتوبيس اليوم (${DAYS[dowOf(trip.trip_date)]} ${trip.trip_date}) رغم أنه يوم ركوبه.\nلو فيه ظرف طارئ يرجى التواصل مع الجمعية.`);
    }
    out.push({ code: s.code, name: s.full_name, parent_phone: s.parent_phone, notified: sent });
  }
  await db.from("trips").update({ absent_notified: true }).eq("id", trip.id);
  return out;
}

// ---------------------------------------------------------------------
//  تقرير يوم كامل
// ---------------------------------------------------------------------
async function buildReport(date: string) {
  const { data: trips } = await db.from("trips")
    .select("id, kind, trip_date, started_at, ended_at, bus_id, supervisor_id, buses(name, capacity)")
    .eq("trip_date", date).order("started_at");
  if (!trips?.length) return `📋 <b>تقرير ${DAYS[dowOf(date)]} ${date}</b>\nمفيش رحلات اتسجلت النهارده.`;

  const { data: staff } = await db.from("profiles").select("id, full_name");
  const nameOf = (id: string) => staff?.find((p) => p.id === id)?.full_name ?? "—";

  let msg = `📋 <b>تقرير ${DAYS[dowOf(date)]} ${date}</b>\n${esc(ORG)}\n`;
  for (const t of trips as any[]) {
    const { data: rides } = await db.from("rides").select("scanned_by, scanned_at, students(code, full_name)")
      .eq("trip_id", t.id).order("scanned_at");
    const { data: denied } = await db.from("scan_log").select("result, students(full_name)").eq("trip_id", t.id);
    const sups = [...new Set([t.supervisor_id, ...(rides ?? []).map((r: any) => r.scanned_by)].filter(Boolean))];

    msg += `\n━━━━━━━━━━━━\n🚌 <b>${esc(t.buses?.name)}</b> — ${KIND[t.kind]}\n`;
    msg += `👤 المشرفين: ${sups.map((id) => esc(nameOf(id))).join("، ") || "—"}\n`;
    msg += `🕒 من ${cairoTime(t.started_at)} إلى ${t.ended_at ? cairoTime(t.ended_at) : "لم تُقفل"}\n`;
    msg += `✅ ركب: <b>${rides?.length ?? 0}</b> من ${t.buses?.capacity}\n`;

    if (t.kind === "go") {
      const abs = await absentees(t);
      msg += `❌ غياب: <b>${abs.length}</b>${abs.length ? "\n" + abs.map((a) => `  • ${esc(a.full_name)} (${a.code})${a.parent_chat_id ? "" : " — ولي الأمر غير مربوط"}`).join("\n") : ""}\n`;
    }
    const rej = (denied ?? []).filter((d: any) => d.result !== "unknown");
    const unknown = (denied ?? []).length - rej.length;
    if (rej.length) {
      const label: Record<string, string> = { not_today: "مش يومه", suspended: "موقوف", other_bus: "باص تاني", full: "الباص كامل" };
      msg += `⚠️ محاولات مرفوضة:\n` + rej.map((d: any) => `  • ${esc(d.students?.full_name)} — ${label[d.result] ?? d.result}`).join("\n") + "\n";
    }
    if (unknown) msg += `🚫 كروت غير معروفة: ${unknown}\n`;
    if (rides?.length) {
      msg += `\n<b>الركاب:</b>\n` + rides.map((r: any, i: number) =>
        `${i + 1}. ${esc(r.students?.full_name)} — ${cairoTime(r.scanned_at)} (${esc(nameOf(r.scanned_by))})`).join("\n") + "\n";
    }
  }
  return msg;
}

async function sendLong(chat: number, text: string) {
  // حد رسالة تليجرام 4096 حرف
  const parts: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + line).length > 3800) { parts.push(cur); cur = ""; }
    cur += line + "\n";
  }
  if (cur.trim()) parts.push(cur);
  for (const p of parts) await tg(chat, p);
}

async function dailyJob(date: string) {
  // لو المشرف نسي يقفل رحلة الذهاب — نبعت الغياب بردو
  const { data: open } = await db.from("trips").select("*").eq("trip_date", date).eq("kind", "go").eq("absent_notified", false);
  for (const t of open ?? []) await notifyAbsence(t);
  await db.from("trips").update({ ended_at: new Date().toISOString() }).eq("trip_date", date).is("ended_at", null);

  const report = await buildReport(date);
  for (const c of await adminChats()) await sendLong(c, report);
  const { data: trips } = await db.from("trips").select("id").eq("trip_date", date);
  const { count } = trips?.length ? await db.from("rides").select("id", { count: "exact", head: true }).in("trip_id", trips.map((t) => t.id)) : { count: 0 };
  await push({ admins: true, title: `تقرير ${DAYS[dowOf(date)]} ${date}`, body: `${trips?.length ?? 0} رحلة — ${count ?? 0} ركوب. التفاصيل على تليجرام.`, tag: "daily-" + date });
  return report;
}

// ---------------------------------------------------------------------
//  تليجرام
// ---------------------------------------------------------------------
async function onTelegram(update: any) {
  const m = update.message;
  if (!m?.text) return;
  const chat = m.chat.id;
  const [cmd, arg] = m.text.trim().split(/\s+/, 2);

  if (cmd === "/start" && arg?.startsWith("adm_")) {
    const { data } = await db.from("profiles").update({ tg_chat_id: chat })
      .eq("tg_link_token", arg.slice(4)).select("full_name").maybeSingle();
    return tg(chat, data ? `✅ أهلًا ${esc(data.full_name)} — اتربط حسابك وهيوصلك تقرير آخر اليوم هنا.\n\nالأوامر:\n/today تقرير النهارده لحد دلوقتي\n/find اسم أو كود — بيانات طالب`
      : "❌ الرابط ده مش صالح.");
  }
  if (cmd === "/start" && arg) {
    const { data } = await db.from("students").update({ parent_chat_id: chat })
      .eq("parent_link_token", arg).select("full_name, days").maybeSingle();
    if (!data) return tg(chat, "❌ الرابط ده مش صالح. اطلب رابط جديد من الجمعية.");
    const days = (data.days ?? []).map((d: number) => DAYS[d]).join("، ") || "لم تُحدد";
    return tg(chat, `✅ تم ربطك كولي أمر <b>${esc(data.full_name)}</b>.\nأيام الركوب: ${days}\nهيوصلك إشعار هنا لو يومه ومركبش الأتوبيس.\n\n${esc(ORG)}`);
  }

  // باقي الأوامر للأدمن بس
  const { data: me } = await db.from("profiles").select("role").eq("tg_chat_id", chat).eq("active", true).maybeSingle();
  if (me?.role !== "admin") return tg(chat, `🚌 ${esc(ORG)}\nالبوت ده للإشعارات. لو انت ولي أمر افتح رابط الربط اللي وصلك من الجمعية.`);

  if (cmd === "/today") return sendLong(chat, await buildReport(cairoDate()));
  if (cmd === "/find" && arg) {
    const q = m.text.trim().slice(5).trim();
    const isNum = /^\d+$/.test(q);
    const { data } = await (isNum ? db.from("students").select("*, buses(name)").eq("code", +q)
      : db.from("students").select("*, buses(name)").ilike("full_name", `%${q}%`)).limit(5);
    if (!data?.length) return tg(chat, "مفيش نتيجة.");
    return tg(chat, data.map((s: any) =>
      `<b>${esc(s.full_name)}</b> (${s.code})${s.suspended ? " ⛔ موقوف" : ""}\n🚌 ${esc(s.buses?.name ?? "—")}\n📅 ${(s.days ?? []).map((d: number) => DAYS[d]).join("، ") || "—"}\n📞 ${esc(s.phone ?? "—")} | ولي الأمر: ${esc(s.parent_phone ?? "—")}\n📍 ${esc(s.address ?? "—")}`).join("\n\n"));
  }
  return tg(chat, "الأوامر:\n/today تقرير النهارده\n/find اسم أو كود");
}

// ---------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    // Webhook من تليجرام
    if (TG_SECRET && req.headers.get("x-telegram-bot-api-secret-token") === TG_SECRET) {
      await onTelegram(await req.json());
      return json({ ok: true });
    }
    // pg_cron — تقرير آخر اليوم
    if (action === "daily") {
      if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) return json({ error: "forbidden" }, 403);
      await dailyJob(cairoDate());
      return json({ ok: true });
    }

    // من هنا: طلبات من التطبيق — لازم مستخدم مسجل
    const jwt = (req.headers.get("authorization") ?? "").replace("Bearer ", "");
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: "سجّل دخول الأول" }, 401);
    const { data: me } = await db.from("profiles").select("id, role, active").eq("id", u.user.id).maybeSingle();
    if (!me?.active) return json({ error: "الحساب غير مفعّل" }, 403);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    if (action === "trip_end") {
      const { data: trip } = await db.from("trips").select("*").eq("id", body.trip_id).maybeSingle();
      if (!trip) return json({ error: "الرحلة غير موجودة" }, 404);
      const absent = trip.kind === "go" && !trip.absent_notified ? await notifyAbsence(trip)
        : trip.kind === "go" ? (await absentees(trip)).map((s) => ({ code: s.code, name: s.full_name, parent_phone: s.parent_phone, notified: !!s.parent_chat_id })) : [];
      const { data: bus } = await db.from("buses").select("name, capacity").eq("id", trip.bus_id).maybeSingle();
      const { count: rode } = await db.from("rides").select("id", { count: "exact", head: true }).eq("trip_id", trip.id);
      const { data: sup } = await db.from("profiles").select("full_name").eq("id", me.id).maybeSingle();
      await push({
        admins: true, tag: "trip-" + trip.id,
        title: `${bus?.name ?? "الباص"} — ${KIND[trip.kind]} خلصت`,
        body: `ركب ${rode ?? 0} من ${bus?.capacity ?? "?"}${trip.kind === "go" ? ` — غياب ${absent.length}` : ""} — ${sup?.full_name ?? ""}`,
      });
      // المشرف مش بيشوف أرقام أولياء الأمور
      if (me.role !== "admin") absent.forEach((a: any) => delete a.parent_phone);
      return json({ ok: true, absent });
    }

    if (action === "push_test") {
      const sent = await push({ user_ids: [me.id], title: "أتوبيس الخير", body: "الإشعارات شغالة على الجهاز ده ✓", tag: "test" });
      return json({ ok: true, sent });
    }

    if (me.role !== "admin") return json({ error: "للأدمن فقط" }, 403);

    if (action === "report") {
      const date = body.date || cairoDate();
      const text = await buildReport(date);
      const chats = await adminChats();
      for (const c of chats) await sendLong(c, text);
      return json({ ok: true, sent: chats.length });
    }
    if (action === "create_user") {
      const username = String(body.username ?? "").trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,}$/.test(username)) return json({ error: "اسم الدخول بالإنجليزي وأرقام بس (3 حروف على الأقل)" }, 400);
      if (!/^\d{6,}$/.test(String(body.pin ?? ""))) return json({ error: "الـ PIN لازم 6 أرقام على الأقل" }, 400);
      const { data: created, error } = await db.auth.admin.createUser({
        email: `${username}@${EMAIL_DOMAIN}`, password: String(body.pin), email_confirm: true,
      });
      if (error) return json({ error: error.message.includes("already") ? "اسم الدخول ده مستخدم" : error.message }, 400);
      const { error: e2 } = await db.from("profiles").insert({
        id: created.user.id, username, full_name: body.full_name || username,
        role: body.role === "admin" ? "admin" : "supervisor",
      });
      if (e2) return json({ error: e2.message }, 400);
      return json({ ok: true });
    }
    if (action === "reset_pin") {
      if (!/^\d{6,}$/.test(String(body.pin ?? ""))) return json({ error: "الـ PIN لازم 6 أرقام على الأقل" }, 400);
      const { error } = await db.auth.admin.updateUserById(body.user_id, { password: String(body.pin) });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }
    return json({ error: "action غير معروف" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
