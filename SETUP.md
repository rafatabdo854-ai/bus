# أتوبيس الخير — خطوات التركيب

نفس فكرة مشروع الهنا: **Supabase** (قاعدة بيانات + دخول + صور + سيرفر صغير للبوت) و**Cloudflare Pages** للواجهة من ريبو GitHub. كله على الخطة المجانية.

```
bus/
├── index.html            ← التطبيق كله (أدمن + مشرف)
├── logo.jpg / icon-512.png / manifest.webmanifest
└── supabase/
    ├── schema.sql        ← الجداول والصلاحيات ودوال المسح
    └── functions/bot/index.ts   ← بوت تليجرام + الإشعارات + التقرير اليومي
```

---

## 1) مشروع Supabase

1. من supabase.com اعمل مشروع جديد باسم `bus` (منفصل عن `mp-store`). الخطة المجانية بتسمح بمشروعين شغالين بس، فلو عندك أكتر هتحتاج توقف واحد.
2. **SQL Editor → New query** → الصق `supabase/schema.sql` كله → Run.
3. **Authentication → Sign In / Providers → Email**: اقفل **Allow new users to sign up** (الحسابات بتتعمل من جوه التطبيق بس).
4. **Project Settings → API**: انسخ `Project URL` و`anon public key`.

## 2) أول حساب أدمن

1. **Authentication → Users → Add user → Create new user**
   - Email: `admin@bus.local` — (اسم الدخول هيبقى `admin`)
   - Password: رقم من 6 أرقام على الأقل — ده الـ PIN
   - علّم **Auto Confirm User**
2. في SQL Editor:

```sql
insert into profiles (id, username, full_name, role)
select id, 'admin', 'مدير النظام', 'admin' from auth.users where email = 'admin@bus.local';
```

باقي المشرفين بتعملهم من التطبيق نفسه (الإعدادات → + مستخدم).

## 3) بوت تليجرام

1. في تليجرام افتح **@BotFather** → `/newbot` → اختار اسم زي `Qawafel Bus Bot` ويوزر بيخلص بـ `bot`.
2. خد الـ **token** واليوزر.

## 4) الـ Edge Function (البوت والإشعارات)

من لوحة Supabase من غير أي برامج:

1. **Edge Functions → Deploy a new function → Via Editor**، اسمها `bot` بالظبط.
2. الصق محتوى `supabase/functions/bot/index.ts` → Deploy.
3. افتح الـ function → **Details** → اقفل **Verify JWT with legacy secret / Enforce JWT verification** (تليجرام مش بيبعت JWT، والكود بيتحقق بنفسه).
4. **Edge Functions → Secrets** ضيف:

| الاسم | القيمة |
|---|---|
| `TELEGRAM_BOT_TOKEN` | التوكن من BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | أي كلمة عشوائية طويلة (حروف وأرقام) |
| `CRON_SECRET` | كلمة عشوائية تانية |
| `ORG_NAME` | `أتوبيس الخير — جمعية القوافل` |

5. اربط البوت بالـ function — افتح الرابط ده في المتصفح بعد ما تغيّر القيم:

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<PROJECT>.supabase.co/functions/v1/bot&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

المفروض يرد `"ok":true`.

## 5) تقرير آخر اليوم التلقائي

1. **Database → Extensions**: فعّل `pg_cron` و`pg_net`.
2. SQL Editor (غيّر `<PROJECT>` و`<CRON_SECRET>`):

```sql
select cron.schedule('bus-daily-report', '0 18 * * *', $$
  select net.http_post(
    url := 'https://<PROJECT>.supabase.co/functions/v1/bot?action=daily',
    headers := '{"Content-Type":"application/json","x-cron-secret":"<CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb)
$$);
```

الوقت بتوقيت UTC: `18:00` = 9 بالليل صيفي / 8 شتوي في مصر. التقرير ده كمان بيبعت إشعار الغياب لو المشرف نسي يقفل رحلة الذهاب، وبيقفل أي رحلة مفتوحة.

## 6) الواجهة على Cloudflare Pages

1. افتح `index.html` وعدّل `CONFIG` فوق في أول الـ script:
   `SUPABASE_URL` و`SUPABASE_ANON_KEY` و`BOT_USERNAME` (من غير @).
2. ارفع الملفات دي مكان القديمة في ريبو `rafatabdo854-ai/bus` (امسح `qr.html` القديم): `index.html`, `logo.jpg`, `icon-512.png`, `manifest.webmanifest` (وفولدر `supabase` عادي يترفع للتوثيق).
3. Cloudflare → **Workers & Pages → Create → Pages → Connect to Git** → اختار `bus` → Build command فاضي، Output directory `/` → Deploy.
4. هيبقى عندك لينك زي `https://bus-xxx.pages.dev`.

> الـ anon key عادي يبقى في الكود — الحماية كلها من RLS في `schema.sql`. أوعى تحط الـ service role key في `index.html`.

---

## طريقة الشغل

### الأدمن (مرة واحدة)
1. **الإعدادات**: تأكد من الباص وعدد الكراسي (28 افتراضي) → اعمل حساب لكل مشرف (الـ PIN بيتولّد لوحده) → دوس **ربط حسابي بالبوت** ودوس Start.
2. **الطلاب**: `+ طالب` أو **استيراد من Excel** (أعمدة: الاسم، رقم الطالب، اسم ولي الأمر، رقم ولي الأمر، العنوان، الأيام — الأيام تتكتب كده: `سبت، اثنين، أربعاء`). بيانات الشيت القديم: من Google Sheets → File → Download → xlsx وارفعه.
3. بعد إضافة الطالب بيفتحلك **الكارت** على طول → **إرسال واتساب** → يفتح شات ولي الأمر والرسالة جاهزة فيها رابط الكارت ورابط تفعيل تليجرام.

### المشرف (كل يوم)
1. يفتح اللينك من الموبايل → من قائمة المتصفح **Add to Home screen** (مرة واحدة، بيبقى زي الأبلكيشن).
2. يختار **ذهاب** أو **عودة** → الكاميرا تشتغل → يمسح الكروت ورا بعض:
   - 🟢 **اركب** — 🔵 ركب قبل كده — 🔴 مش يومه / موقوف / كارت غير صالح — 🟠 الباص كامل / باص تاني
3. **يدوي** لو الطالب ناسي الكارت، **تراجع** لو سجّل حد بالغلط، **إنهاء** في آخر الرحلة.
4. إنهاء رحلة **الذهاب** = إشعار غياب فوري على تليجرام لكل ولي أمر ابنه يومه ومركبش.

### أولياء الأمور
بيدوسوا على رابط تليجرام اللي في رسالة الكارت → Start → خلاص اتربطوا. اللي مش مربوط بيظهر للأدمن في **التقارير → الغياب** بزرار واتساب جاهز.

### أوامر البوت للأدمن
- `/today` تقرير النهارده لحد دلوقتي
- `/find 1024` أو `/find أحمد` بيانات طالب

---

## مشاكل شائعة
- **الكاميرا مش بتفتح**: لازم اللينك `https` (Cloudflare بيعمل كده لوحده) وتسمح للكاميرا من إعدادات المتصفح.
- **"اسم الدخول أو الرقم السري غلط"**: اسم الدخول بالإنجليزي small، والـ PIN 6 أرقام.
- **البوت مبيردش**: افتح `https://api.telegram.org/bot<TOKEN>/getWebhookInfo` وشوف `last_error_message`، واتأكد إن Verify JWT مقفول.
- **كارت اتسرق أو ضاع**: من بيانات الطالب → **إلغاء الكارت وإصدار جديد** — القديم بيبطل فورًا.
