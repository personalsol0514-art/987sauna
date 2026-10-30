const crypto = require("crypto");
const { afterResponse } = require("./after-response");
const { notifyReservationCancelled, notifyReservationCreated } = require("./discord");
const { getPool } = require("./db");
const { getSessionFromEvent } = require("./auth");
const { sendCancellationMail, sendReservationConfirmation } = require("./mail");
const { appendReservation, updateReservation } = require("./sheet");

const JST_OFFSET = "+09:00";
const MAX_AVAILABILITY_DAYS = 93;
// 枠を使っている予約。精算済み（completed）・来店なし（no_show）も、その時間は枠が埋まったままにする（先に精算しても二重予約にならないように）
const ACTIVE_STATUSES = ["pending", "confirmed", "checked_in", "completed", "no_show"];
const { siteOrigin, trustedOrigins } = require("./共通URL");
let optionColumnCache = null;

function json(statusCode, body, event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || "";
  const allowedOrigins = trustedOrigins();
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": allowedOrigins.has(origin) ? origin : siteOrigin(),
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-allow-credentials": "true",
    },
    body: JSON.stringify(body),
  };
}

function reservationCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return "R-" + Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function manageToken() {
  return crypto.randomBytes(48).toString("base64url");
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function toDateTime(date, time) {
  if (time === "24:00") {
    const next = new Date(`${date}T00:00:00${JST_OFFSET}`);
    next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  return new Date(`${date}T${time}:00${JST_OFFSET}`);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addDays(date, days) {
  return new Date(date.getTime() + Number(days || 0) * 24 * 60 * 60 * 1000);
}

function bookingOpenDays(value) {
  const days = Number(value);
  return Number.isFinite(days) && days >= 0 ? days : 60;
}

function dateKeyInJst(value) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(value));
}

function todayKeyInJst() {
  return dateKeyInJst(new Date());
}

function maxBookableDate(openDays = 60) {
  const date = toDateTime(todayKeyInJst(), "00:00");
  date.setUTCDate(date.getUTCDate() + bookingOpenDays(openDays));
  return dateKeyInJst(date);
}

function timeKeyInJst(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function isoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function normalizeEmail(value) {
  return String(value || "").trim();
}

function validEmail(value) {
  const email = normalizeEmail(value);
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizePhone(value) {
  return String(value || "")
    .trim()
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[－ー―–—ｰ]/g, "-");
}

function validPhone(value) {
  const phone = normalizePhone(value);
  if (!/^[0-9-]+$/.test(phone)) return false;
  const digits = phone.replace(/-/g, "");
  return /^0\d{9,10}$/.test(digits);
}

function slotIndex(slotId) {
  const match = String(slotId || "").match(/^s(\d+)$/);
  return match ? Number(match[1]) - 1 : -1;
}

function slotKey(date, slotId) {
  return `${date}_${slotId}`;
}

function daysBetween(from, to) {
  const out = [];
  const cursor = toDateTime(from, "00:00");
  const end = toDateTime(to, "00:00");
  while (cursor <= end) {
    out.push(dateKeyInJst(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function weekdayInJst(date) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", weekday: "short" })
    .format(new Date(`${date}T12:00:00${JST_OFFSET}`))
    .replace("Sun", "0")
    .replace("Mon", "1")
    .replace("Tue", "2")
    .replace("Wed", "3")
    .replace("Thu", "4")
    .replace("Fri", "5")
    .replace("Sat", "6"));
}

// DB（シンガポール）と関数（米国）の往復がそのまま待ち時間になるため、クエリはなるべく1回にまとめる
const CONFIG_COLUMNS = `
  (select row_to_json(x) from (select timezone, slot_start_times, booking_open_days from store_settings order by created_at asc limit 1) x) as settings,
  (select row_to_json(x) from (select id, name, capacity from resources where is_active = true order by sort_order asc, created_at asc limit 1) x) as resource,
  (select row_to_json(x) from (select * from plans where is_active = true order by sort_order asc, created_at asc limit 1) x) as plan`;

function requireConfig(row) {
  if (!row || !row.settings || !row.resource || !row.plan) throw new Error("reservation base config is missing");
  return { settings: row.settings, resource: row.resource, plan: row.plan };
}

async function baseConfig(db) {
  const { rows } = await db.query(`select ${CONFIG_COLUMNS}`);
  return requireConfig(rows[0]);
}
async function adminSession(client, event, roles = []) {
  let session;
  try {
    session = getSessionFromEvent(event);
  } catch {
    return null;
  }
  if (!session) return null;
  const result = await client.query(
    "select id, login_id, name, role from admin_users where id = $1 and is_active = true limit 1",
    [session.sub],
  );
  const user = result.rows[0] || null;
  if (!user) return null;
  if (roles.length && !roles.includes(user.role)) return null;
  return user;
}

function buildSlots(settings, plan) {
  return settings.slot_start_times.map((start, index) => {
    const startDate = toDateTime("2026-01-01", start);
    const serviceEnd = addMinutes(startDate, plan.duration_minutes);
    return {
      id: `s${index + 1}`,
      label: `${start} - ${timeKeyInJst(serviceEnd)}`,
      start,
      end: timeKeyInJst(serviceEnd),
    };
  });
}

function buildSlotTimes(date, slotId, settings, plan) {
  const index = slotIndex(slotId);
  const startText = settings.slot_start_times[index];
  if (!startText) return null;
  const startAt = toDateTime(date, startText);
  const serviceEndAt = addMinutes(startAt, plan.duration_minutes);
  const endAt = addMinutes(serviceEndAt, plan.buffer_minutes);
  return { startAt, serviceEndAt, endAt };
}

function tiersFromRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const code = row.tier_code || `p${row.guest_count}`;
    const current = grouped.get(code) || {
      code,
      name: row.tier_name || `${row.guest_count}名様`,
      nameEn: row.tier_name_en || "",
      min: row.guest_count,
      max: row.guest_count,
      price: row.price,
      image: row.image_path,
    };
    current.min = Math.min(current.min, row.guest_count);
    current.max = Math.max(current.max, row.guest_count);
    current.price = row.price;
    grouped.set(code, current);
  }
  return Array.from(grouped.values()).map((tier) => ({
    ...tier,
    guests: tier.min === tier.max ? `${tier.min}名様` : `${tier.min}〜${tier.max}名様`,
  }));
}
function policyFromRows(rows) {
  return {
    rules: rows.map((row) => ({
      minutesBefore: row.minutes_before_start,
      hoursBefore: row.minutes_before_start / 60,
      feePercent: row.fee_percent,
    })),
  };
}

async function optionColumns(client) {
  if (optionColumnCache) return optionColumnCache;
  const result = await client.query(
    `select column_name
     from information_schema.columns
     where table_schema = 'public'
       and table_name = 'options'
       and column_name = any($1::text[])`,
    [["lead_time_days", "is_request_only", "is_bookable_online"]],
  );
  const names = new Set(result.rows.map((row) => row.column_name));
  optionColumnCache = {
    leadTimeDays: names.has("lead_time_days"),
    isRequestOnly: names.has("is_request_only"),
    isBookableOnline: names.has("is_bookable_online"),
  };
  return optionColumnCache;
}

async function listAvailability(payload, event) {
  const from = payload.from || dateKeyInJst(new Date());
  const to = payload.to || from;
  const fromAt = isoDate(from) ? toDateTime(from, "00:00") : new Date(NaN);
  const toAt = isoDate(to) ? toDateTime(to, "00:00") : new Date(NaN);
  if (!Number.isFinite(fromAt.getTime()) || !Number.isFinite(toAt.getTime()) ||
      dateKeyInJst(fromAt) !== from || dateKeyInJst(toAt) !== to ||
      toAt < fromAt || (toAt - fromAt) / 86400000 >= MAX_AVAILABILITY_DAYS) {
    return json(400, { ok: false, error: "invalid_availability_range", message: "空き状況は93日以内の期間を指定してください。" }, event);
  }
  const db = getPool();
  const columns = await optionColumns(db);
  const toEnd = toDateTime(to, "24:00");
  // 設定・予約・休止・開閉・料金・オプション・キャンセル規定を1回で取得する
  const { rows } = await db.query(
    `with r as (select id from resources where is_active = true order by sort_order asc, created_at asc limit 1),
          p as (select id, buffer_minutes, cancellation_policy_id from plans where is_active = true order by sort_order asc, created_at asc limit 1)
     select ${CONFIG_COLUMNS},
       coalesce((select json_agg(x) from (
         select start_at from reservations
         where resource_id = (select id from r) and status = any($1::reservation_status[])
           and start_at < $3::timestamptz + make_interval(mins => (select buffer_minutes from p)) and end_at > $2::timestamptz
       ) x), '[]'::json) as booked,
       coalesce((select json_agg(x) from (
         select start_at, end_at, reason from resource_blocks
         where resource_id = (select id from r)
           and start_at < $3::timestamptz + make_interval(mins => (select buffer_minutes from p)) and end_at > $2::timestamptz
       ) x), '[]'::json) as blocks,
       coalesce((select json_agg(x) from (
         select target_date::text as target_date, slot_index, state, reason from slot_overrides
         where resource_id = (select id from r) and target_date >= $4::date and target_date <= $5::date
       ) x), '[]'::json) as overrides,
       coalesce((select json_agg(x order by x.guest_count) from (
         select plan_id, guest_count, price, tier_code, tier_name, tier_name_en, image_path
         from plan_price_tiers where plan_id = (select id from p)
       ) x), '[]'::json) as tiers,
       coalesce((select json_agg(x order by x._ord) from (
         select id, name, category, price, max_qty as "maxQty", note,
                ${columns.leadTimeDays ? "lead_time_days" : "0"} as "leadTimeDays",
                ${columns.isRequestOnly ? "is_request_only" : "false"} as "isRequestOnly",
                ${columns.isBookableOnline ? "is_bookable_online" : "false"} as "isBookableOnline",
                row_number() over (order by sort_order asc, created_at asc) as _ord
         from options
         where is_active = true and ${columns.isBookableOnline ? "is_bookable_online = true" : "false"}
       ) x), '[]'::json) as options,
       coalesce((select json_agg(x order by x.minutes_before_start desc) from (
         select minutes_before_start, fee_percent from cancellation_policy_rules
         where policy_id = (select cancellation_policy_id from p)
       ) x), '[]'::json) as policy_rules`,
    [ACTIVE_STATUSES, fromAt.toISOString(), toEnd.toISOString(), from, to],
  );
  const row = rows[0];
  const { settings, plan } = requireConfig(row);
  const slots = buildSlots(settings, plan);
  const openUntil = maxBookableDate(settings.booking_open_days);
  const tierRows = tiersFromRows(row.tiers);
  const optionRows = row.options.map(({ _ord, ...option }) => option);
  const policy = policyFromRows(row.policy_rules);
  const bookedSlots = row.booked.map((b) => {
    const date = dateKeyInJst(b.start_at);
    const start = timeKeyInJst(b.start_at);
    const index = settings.slot_start_times.indexOf(start);
    return index >= 0 ? slotKey(date, `s${index + 1}`) : null;
  }).filter(Boolean);
  const overrideMap = new Map(row.overrides.map((o) => [`${o.target_date}_${o.slot_index}`, o]));
  const blockRows = [];
  for (const date of daysBetween(from, to)) {
    for (const slot of slots) {
      const override = overrideMap.get(`${date}_${slotIndex(slot.id)}`);
      const times = buildSlotTimes(date, slot.id, settings, plan);
      const hit = row.blocks.find((block) => new Date(block.start_at) < times.endAt && new Date(block.end_at) > times.startAt);
      if (hit) blockRows.push({ date, slotId: slot.id, reason: hit.reason || "blocked" });
      else if (date > openUntil) blockRows.push({ date, slotId: slot.id, reason: "受付期間外" });
      else if (!override || override.state !== "open") blockRows.push({ date, slotId: slot.id, reason: override?.reason || "closed" });
    }
  }
  return json(200, { ok: true, slots, tiers: tierRows, options: optionRows, bookedSlots, blocks: blockRows, policy, bookingOpenDays: bookingOpenDays(settings.booking_open_days), maxBookableDate: openUntil }, event);
}

function validateBooking(payload, { phoneBooking = false } = {}) {
  if (!isoDate(payload.date)) return "日付を選択してください。";
  if (!payload.slotId) return "時間枠を選択してください。";
  if (!Number.isInteger(Number(payload.guestCount))) return "人数を選択してください。";
  if (!String(payload.name || "").trim()) return "お名前を入力してください。";
  if (!phoneBooking && !String(payload.email || "").trim()) return "メールアドレスを入力してください。";
  if (String(payload.email || "").trim() && !validEmail(payload.email)) return "メールアドレスの形式が正しくありません。";
  if (!String(payload.phone || "").trim()) return "電話番号を入力してください。";
  if (!validPhone(payload.phone)) return "電話番号を正しく入力してください。";
  if (!phoneBooking && payload.agreedTerms !== true) return "規約とキャンセル規定への同意が必要です。";
  if (payload.hasMinor === true && payload.guardianConfirmed !== true) return "18歳以下の方は保護者同伴を確認してください。";
  return null;
}

function optionalText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function optionalPrefectureCode(value) {
  const code = Number(value);
  return Number.isInteger(code) && code >= 1 && code <= 99 ? code : null;
}

async function existingByIdempotency(client, idempotencyKey) {
  if (!idempotencyKey) return null;
  const result = await client.query(
    `select * from reservations where idempotency_key = $1 limit 1`,
    [idempotencyKey],
  );
  return result.rows[0] || null;
}

function bookingResponse(row, policy) {
  const date = dateKeyInJst(row.start_at);
  const start = timeKeyInJst(row.start_at);
  const end = timeKeyInJst(row.service_end_at);
  return {
    ok: true,
    reservationCode: row.reservation_code,
    number: row.reservation_code,
    manageToken: row.manage_token,
    totalPrice: row.total_price,
    cancellationFee: row.cancellation_fee || 0,
    cancellationFeeRate: cancellationFeeRate(row, policy),
    booking: {
      id: row.id,
      reservationCode: row.reservation_code,
      number: row.reservation_code,
      date,
      slot: `${start} - ${end}`,
      slotId: row.slot_id,
      guestCount: row.guest_count,
      planName: row.plan_name || "",
      planId: row.tier_code || "",
      name: row.contact_name,
      kana: row.contact_kana,
      email: row.contact_email,
      phone: row.contact_phone,
      totalPrice: row.total_price,
      status: row.status,
      manageToken: row.manage_token,
    },
  };
}

function phoneBookingResponse(row, policy) {
  const result = bookingResponse(row, policy);
  return {
    ok: true,
    reservationCode: result.reservationCode,
    date: result.booking.date,
    slot: result.booking.slot,
    guestCount: result.booking.guestCount,
    totalPrice: result.totalPrice,
    confirmationEmailRequested: Boolean(row.contact_email),
  };
}

function cancellationFeeRate(row, policy) {
  const minutesUntil = Math.floor((new Date(row.start_at).getTime() - Date.now()) / 60000);
  let feePercent = 0;
  for (const rule of [...(policy?.rules || [])].sort((a, b) => b.minutesBefore - a.minutesBefore)) {
    if (minutesUntil <= rule.minutesBefore) feePercent = Math.max(feePercent, rule.feePercent);
  }
  return feePercent;
}

async function enrichedReservation(client, id) {
  const result = await client.query(
    `select r.*, p.name as plan_name, t.tier_code,
            coalesce(ro.options_text, '') as options_text,
            coalesce(ro.has_bbq_request, false) as has_bbq_request
     from reservations r
     join plans p on p.id = r.plan_id
     left join plan_price_tiers t on t.plan_id = r.plan_id and t.guest_count = r.guest_count
     left join lateral (
       select
         string_agg(
           opt.name_snapshot || case when opt.quantity > 1 then ' x' || opt.quantity::text else '' end,
           ' / '
           order by opt.name_snapshot
         ) as options_text,
         bool_or(opt.name_snapshot ilike 'BBQ%') as has_bbq_request
       from reservation_options opt
       where opt.reservation_id = r.id
     ) ro on true
     where r.id = $1
     limit 1`,
    [id],
  );
  return result.rows[0] || null;
}

async function createBooking(payload, event, { admin = null } = {}) {
  const phoneBooking = Boolean(admin);
  const error = validateBooking(payload, { phoneBooking });
  if (error) return json(400, { ok: false, error: "invalid_booking", message: error }, event);
  const idempotencyKey = payload.idempotencyKey || crypto.randomUUID();
  if (!isUuid(idempotencyKey)) return json(400, { ok: false, error: "invalid_idempotency_key" }, event);
  const requestedOptions = Array.isArray(payload.options) ? payload.options : [];
  if (requestedOptions.some((item) => !isUuid(item.id))) {
    return json(400, { ok: false, error: "invalid_option", message: "選択できないオプションが含まれています。" }, event);
  }

  const db = getPool();
  try {
    const contactEmail = normalizeEmail(payload.email) || null;
    const contactPhone = normalizePhone(payload.phone);

    // 1往復目：設定と、同じ送信がすでに確定していないか
    const first = await db.query(
      `select ${CONFIG_COLUMNS},
         (select row_to_json(x) from (select * from reservations where idempotency_key = $1 limit 1) x) as existing`,
      [idempotencyKey],
    );
    const { settings, resource, plan } = requireConfig(first.rows[0]);
    const existing = first.rows[0].existing;
    if (existing) return json(200, phoneBooking
      ? phoneBookingResponse(existing, existing.policy_snapshot || { rules: [] })
      : bookingResponse(existing, existing.policy_snapshot || { rules: [] }), event);

    const openUntil = maxBookableDate(settings.booking_open_days);
    if (payload.date > openUntil) {
      return json(400, { ok: false, error: "outside_booking_window", message: `${bookingOpenDays(settings.booking_open_days)}日より先の日付はまだ予約できません。` }, event);
    }
    const times = buildSlotTimes(payload.date, payload.slotId, settings, plan);
    if (!times) return json(400, { ok: false, error: "invalid_slot", message: "時間枠が正しくありません。" }, event);
    if (times.startAt <= new Date()) return json(400, { ok: false, error: "past_slot", message: "過去の日時は予約できません。" }, event);
    if (!phoneBooking && times.startAt.getTime() - Date.now() < 2 * 60 * 60 * 1000) {
      return json(400, { ok: false, error: "booking_cutoff", message: "開始2時間前を過ぎた枠は予約できません。" }, event);
    }

    // 2往復目：人数の料金・枠が開いているか・休止・キャンセル規定・オプション
    const guestCount = Number(payload.guestCount);
    const columns = await optionColumns(db);
    const second = await db.query(
      `select
         (select row_to_json(x) from (select price, tier_code from plan_price_tiers where plan_id = $1 and guest_count = $2 limit 1) x) as tier,
         exists(select 1 from slot_overrides where resource_id = $3 and target_date = $4::date and slot_index = $5 and state = 'open') as is_open,
         exists(select 1 from resource_blocks where resource_id = $3 and start_at < $7 and end_at > $6) as is_blocked,
         coalesce((select json_agg(x order by x.minutes_before_start desc) from (
           select minutes_before_start, fee_percent from cancellation_policy_rules where policy_id = $8
         ) x), '[]'::json) as policy_rules,
         coalesce((select json_agg(x) from (
           select id, name, price, max_qty,
                  ${columns.leadTimeDays ? "lead_time_days" : "0"} as lead_time_days,
                  ${columns.isRequestOnly ? "is_request_only" : "false"} as is_request_only,
                  ${columns.isBookableOnline ? "is_bookable_online" : "false"} as is_bookable_online
           from options where id = any($9::uuid[]) and is_active = true
         ) x), '[]'::json) as options`,
      [plan.id, guestCount, resource.id, payload.date, slotIndex(payload.slotId), times.startAt.toISOString(), times.endAt.toISOString(), plan.cancellation_policy_id || null, requestedOptions.map((item) => item.id)],
    );
    const check = second.rows[0];
    if (!check.tier) return json(400, { ok: false, error: "invalid_guest_count", message: "選択できない人数です。" }, event);
    if (!check.is_open) return json(409, { ok: false, conflict: true, reason: "closed", message: "この枠は現在受付できません。" }, event);
    if (check.is_blocked) return json(409, { ok: false, conflict: true, reason: "blocked", message: "この枠は現在受付できません。" }, event);

    let optionsTotal = 0;
    const optionInserts = [];
    for (const item of requestedOptions) {
      const quantity = Math.max(1, Math.min(10, Number(item.quantity || 1)));
      const opt = check.options.find((o) => o.id === item.id);
      if (!opt || !opt.is_bookable_online) {
        return json(400, {
          ok: false,
          error: "option_not_bookable_online",
          message: "このオプションは予約時には選択できません。当日スタッフへお申し付けください。",
        }, event);
      }
      const qty = Math.min(quantity, opt.max_qty);
      const leadTimeDays = Number(opt.lead_time_days || 0);
      if (leadTimeDays > 0 && times.startAt < addDays(new Date(), leadTimeDays)) {
        return json(400, {
          ok: false,
          error: "option_lead_time",
          message: `${opt.name}はご利用日の${leadTimeDays}日前までにお申し込みください。`,
        }, event);
      }
      const requestOnly = Boolean(opt.is_request_only);
      const subtotal = requestOnly ? 0 : opt.price * qty;
      if (!requestOnly) optionsTotal += subtotal;
      optionInserts.push({ option_id: opt.id, name_snapshot: opt.name, unit_price: opt.price, quantity: qty, subtotal });
    }

    const policy = policyFromRows(check.policy_rules);
    const totalPrice = check.tier.price + optionsTotal;
    // 3往復目：予約・オプション・履歴を1文で登録し（途中で失敗すれば全部取り消し）、通知用の情報も受け取る
    // 時間帯が重なる予約は DB の排他制約で弾かれる（二重予約防止）
    const inserted = await db.query(
      `with ins as (
         insert into reservations (
           reservation_code, status, resource_id, plan_id, start_at, end_at, service_end_at,
           guest_count, contact_name, contact_kana, contact_email, contact_phone,
           prefecture_code, referral_source, referral_source_other,
           plan_price, options_total, total_price, policy_snapshot,
           agreed_terms_at, has_minor, guardian_confirmed, manage_token, idempotency_key, note
         ) values (
           $1, 'confirmed', $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11,
           $12, $13, $14,
           $15, $16, $17, $18,
           case when $27::boolean then now() else null end, $19, $20, $21, $22, $23
         )
         returning *
       ), opts as (
         insert into reservation_options (reservation_id, option_id, name_snapshot, unit_price, quantity, subtotal)
         select ins.id, o.option_id, o.name_snapshot, o.unit_price, o.quantity, o.subtotal
         from ins cross join jsonb_to_recordset($24::jsonb) as o(option_id uuid, name_snapshot text, unit_price int, quantity int, subtotal int)
         returning name_snapshot, quantity
       ), hist as (
         insert into reservation_status_histories (reservation_id, from_status, to_status, changed_by, reason)
         select id, null::reservation_status, 'confirmed'::reservation_status, $25, $26 from ins
         returning id
       )
       select ins.*, p.name as plan_name, t.tier_code,
              coalesce((select string_agg(o.name_snapshot || case when o.quantity > 1 then ' x' || o.quantity::text else '' end, ' / ' order by o.name_snapshot) from opts o), '') as options_text,
              coalesce((select bool_or(o.name_snapshot ilike 'BBQ%') from opts o), false) as has_bbq_request
       from ins
       join plans p on p.id = ins.plan_id
       left join plan_price_tiers t on t.plan_id = ins.plan_id and t.guest_count = ins.guest_count`,
      [
        reservationCode(),
        resource.id,
        plan.id,
        times.startAt.toISOString(),
        times.endAt.toISOString(),
        times.serviceEndAt.toISOString(),
        guestCount,
        String(payload.name).trim(),
        optionalText(payload.kana),
        contactEmail,
        contactPhone,
        optionalPrefectureCode(payload.prefectureCode),
        optionalText(payload.referralSource),
        optionalText(payload.referralSourceOther),
        check.tier.price,
        optionsTotal,
        totalPrice,
        JSON.stringify(policy),
        Boolean(payload.hasMinor),
        Boolean(payload.guardianConfirmed || (!payload.hasMinor && payload.agreedTerms)),
        manageToken(),
        idempotencyKey,
        String(payload.note || "").trim(),
        JSON.stringify(optionInserts),
        phoneBooking ? `staff:${admin.id}` : "guest",
        phoneBooking ? "phone_booking" : "web_booking",
        payload.agreedTerms === true,
      ],
    );
    const row = inserted.rows[0];
    await afterResponse(event, "booking notifications", () => Promise.allSettled([
      row.contact_email ? sendReservationConfirmation(row) : Promise.resolve(),
      phoneBooking ? Promise.resolve() : notifyReservationCreated(row),
      appendReservation(row),
    ]));
    if (phoneBooking) return json(200, phoneBookingResponse(row, policy), event);
    return json(200, bookingResponse(row, policy), event);
  } catch (error) {
    if (error.code === "23P01" || error.code === "23505") {
      // 同じ送信（同じ冪等キー）が二重に届いた場合は、先に確定した予約をそのまま返す
      const existing = await existingByIdempotency(db, idempotencyKey).catch(() => null);
      if (existing) return json(200, phoneBooking
        ? phoneBookingResponse(existing, existing.policy_snapshot || { rules: [] })
        : bookingResponse(existing, existing.policy_snapshot || { rules: [] }), event);
      return json(409, { ok: false, conflict: true, reason: "slot_already_booked", message: "この枠はたった今埋まりました。" }, event);
    }
    console.error("createBooking failed", error.code || error.message);
    return json(500, { ok: false, error: "create_booking_failed", message: "予約の登録に失敗しました。" }, event);
  }
}

async function setSlotOverride(payload, event) {
  const client = await getPool().connect();
  try {
    const admin = await adminSession(client, event);
    if (!admin) return json(401, { ok: false, error: "unauthorized" }, event);
    if (admin.role !== "owner") return json(403, { ok: false, error: "forbidden" }, event);
    if (!isoDate(payload.date)) return json(400, { ok: false, error: "invalid_date" }, event);
    const index = slotIndex(payload.slotId);
    if (index < 0) return json(400, { ok: false, error: "invalid_slot" }, event);
    const state = payload.state === "open" ? "open" : "closed";
    const { resource } = await baseConfig(client);
    await client.query(
      `insert into slot_overrides (resource_id, target_date, slot_index, state, reason, note, created_by, updated_at)
       values ($1, $2::date, $3, $4, $5, $6, $7, now())
       on conflict (resource_id, target_date, slot_index)
       do update set state = excluded.state, reason = excluded.reason, note = excluded.note, updated_at = now()`,
      [resource.id, payload.date, index, state, payload.reason || null, payload.note || null, admin.id],
    );
    return json(200, { ok: true });
  } finally {
    client.release();
  }
}

async function bulkSetSlotOverrides(payload, event) {
  const client = await getPool().connect();
  try {
    const admin = await adminSession(client, event);
    if (!admin) return json(401, { ok: false, error: "unauthorized" }, event);
    if (admin.role !== "owner") return json(403, { ok: false, error: "forbidden" }, event);
    if (!isoDate(payload.from) || !isoDate(payload.to)) return json(400, { ok: false, error: "invalid_range" }, event);
    const { resource, settings } = await baseConfig(client);
    const state = payload.state === "open" ? "open" : "closed";
    const weekdays = Array.isArray(payload.weekdays) ? payload.weekdays.map(Number) : [0, 1, 2, 3, 4, 5, 6];
    const slotIds = Array.isArray(payload.slotIds) && payload.slotIds.length ? payload.slotIds : settings.slot_start_times.map((_, i) => `s${i + 1}`);
    const days = daysBetween(payload.from, payload.to).filter((date) => weekdays.includes(weekdayInJst(date)));
    let count = 0;
    await client.query("begin");
    for (const date of days) {
      for (const slotId of slotIds) {
        const index = slotIndex(slotId);
        if (index < 0) continue;
        const booked = await client.query(
          `select 1 from reservations
           where resource_id = $1
             and status = any($2::reservation_status[])
             and start_at::date = $3::date
           limit 1`,
          [resource.id, ACTIVE_STATUSES, date],
        );
        if (booked.rowCount && state === "closed") continue;
        await client.query(
          `insert into slot_overrides (resource_id, target_date, slot_index, state, reason, note, created_by, updated_at)
           values ($1, $2::date, $3, $4, $5, $6, $7, now())
           on conflict (resource_id, target_date, slot_index)
           do update set state = excluded.state, reason = excluded.reason, note = excluded.note, updated_at = now()`,
          [resource.id, date, index, state, payload.reason || null, payload.note || null, admin.id],
        );
        count += 1;
      }
    }
    await client.query("commit");
    return json(200, { ok: true, count });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function findBookingForGuest(client, payload) {
  if (payload.manageToken) {
    const result = await client.query("select * from reservations where manage_token = $1 limit 1", [String(payload.manageToken)]);
    return result.rows[0] || null;
  }
  const code = String(payload.reservationCode || payload.number || "").trim().toUpperCase();
  const email = String(payload.email || "").trim();
  if (!code || !email) return null;
  const result = await client.query(
    "select * from reservations where reservation_code = $1 and lower(contact_email::text) = lower($2) limit 1",
    [code, email],
  );
  return result.rows[0] || null;
}

async function lookupBooking(payload, event) {
  const client = await getPool().connect();
  try {
    const row = await findBookingForGuest(client, payload);
    if (!row) return json(200, { ok: true, booking: null, message: "このご予約は確認できません。" }, event);
    const policy = row.policy_snapshot || { rules: [] };
    const enriched = await enrichedReservation(client, row.id);
    return json(200, bookingResponse(enriched, policy), event);
  } finally {
    client.release();
  }
}

// キャンセル後の予約を、通知に必要な情報（プラン名・オプション）付きで返す
const CANCELLED_ROW_SELECT = `
  select upd.*, p.name as plan_name, t.tier_code,
         coalesce((select string_agg(opt.name_snapshot || case when opt.quantity > 1 then ' x' || opt.quantity::text else '' end, ' / ' order by opt.name_snapshot)
                   from reservation_options opt where opt.reservation_id = upd.id), '') as options_text,
         coalesce((select bool_or(opt.name_snapshot ilike 'BBQ%') from reservation_options opt where opt.reservation_id = upd.id), false) as has_bbq_request
  from upd
  join plans p on p.id = upd.plan_id
  left join plan_price_tiers t on t.plan_id = upd.plan_id and t.guest_count = upd.guest_count`;

async function cancelBooking(payload, event) {
  const db = getPool();
  try {
    const row = await findBookingForGuest(db, payload);
    if (!row) return json(403, { ok: false, error: "forbidden", message: "このご予約は確認できません。" }, event);
    if (row.status !== "confirmed") return json(409, { ok: false, error: "already_cancelled", message: "この予約はすでにキャンセルされています。" }, event);
    const policy = row.policy_snapshot || { rules: [] };
    const feeRate = cancellationFeeRate(row, policy);
    const fee = Math.round((row.total_price * feeRate) / 100);
    const reason = String(payload.reason || "").trim() || "guest_cancel";
    // 状態の更新と履歴の記録を1文で行う（確定中の予約だけが対象なので、同時に2回押されても1回分になる）
    const result = await db.query(
      `with upd as (
         update reservations
         set status = 'cancelled', cancelled_at = now(), cancelled_by = 'guest',
             cancel_reason = $2, cancellation_fee = $3, updated_at = now()
         where id = $1 and status = 'confirmed'
         returning *
       ), hist as (
         insert into reservation_status_histories (reservation_id, from_status, to_status, changed_by, reason)
         select id, 'confirmed'::reservation_status, 'cancelled'::reservation_status, 'guest', $2 from upd
         returning id
       )
       ${CANCELLED_ROW_SELECT}`,
      [row.id, reason, fee],
    );
    const updated = result.rows[0];
    if (!updated) return json(409, { ok: false, error: "already_cancelled", message: "この予約はすでにキャンセルされています。" }, event);
    await afterResponse(event, "cancel notifications", () => Promise.allSettled([sendCancellationMail(updated, feeRate), notifyReservationCancelled(updated, feeRate), updateReservation(updated)]));
    return json(200, { ...bookingResponse(updated, policy), cancelled: true, cancellationFeeRate: feeRate, cancellationFee: fee }, event);
  } catch (error) {
    console.error("cancelBooking failed", error.code || error.message);
    return json(500, { ok: false, error: "cancel_booking_failed", message: "キャンセル処理に失敗しました。" }, event);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true }, event);
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" }, event);

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "invalid_json" }, event);
  }

  try {
    const action = body.action;
    const payload = body.payload || {};
    if (action === "listAvailability") return await listAvailability(payload, event);
    if (action === "createBooking") return await createBooking(payload, event);
    if (action === "lookupBooking") return await lookupBooking(payload, event);
    if (action === "cancelBooking") return await cancelBooking(payload, event);
    if (action === "setSlotOverride") return await setSlotOverride(payload, event);
    if (action === "bulkSetSlotOverrides") return await bulkSetSlotOverrides(payload, event);
    const client = await getPool().connect();
    try {
      const admin = await adminSession(client, event);
      if (!admin) return json(401, { ok: false, error: "unauthorized" }, event);
    } finally {
      client.release();
    }
    return json(400, { ok: false, error: "unknown_action" }, event);
  } catch (error) {
    console.error("reservations api failed", error.code || error.message);
    return json(500, { ok: false, error: "reservation_api_failed", message: "予約APIでエラーが発生しました。" }, event);
  }
};

exports.createPhoneBooking = createBooking;
