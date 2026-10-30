const { audit, currentAdmin, json } = require("./lib/admin-api");
const { getPool } = require("./lib/db");

const JST_OFFSET = "+09:00";
// 枠を使っている予約。精算済み（completed）・来店なし（no_show）も、その時間は枠が埋まったままにする（先に精算しても二重予約にならないように）
const ACTIVE_STATUSES = ["pending", "confirmed", "checked_in", "completed", "no_show"];

function isoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
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

function dateKey(value) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(value));
}

function todayKey() {
  return dateKey(new Date());
}

function bookingOpenDays(value) {
  const days = Number(value);
  return Number.isFinite(days) && days >= 0 ? days : 60;
}

function maxBookableDate(openDays = 60) {
  const date = toDateTime(todayKey(), "00:00");
  date.setUTCDate(date.getUTCDate() + bookingOpenDays(openDays));
  return dateKey(date);
}

function timeKey(value) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function weekday(date) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", weekday: "short" })
    .format(new Date(`${date}T12:00:00${JST_OFFSET}`))
    .replace("Sun", "0").replace("Mon", "1").replace("Tue", "2").replace("Wed", "3")
    .replace("Thu", "4").replace("Fri", "5").replace("Sat", "6"));
}

function daysBetween(from, to) {
  const out = [];
  const cursor = toDateTime(from, "00:00");
  const end = toDateTime(to, "00:00");
  while (cursor <= end) {
    out.push(dateKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function slotIndex(slotId) {
  const match = String(slotId || "").match(/^s(\d+)$/);
  return match ? Number(match[1]) - 1 : -1;
}

// DB（シンガポール）と関数（米国）の往復がそのまま待ち時間になるため、設定は1回のクエリでまとめて取る
async function config(db) {
  const { rows } = await db.query(
    `select
       (select row_to_json(x) from (select slot_start_times, booking_open_days from store_settings order by created_at asc limit 1) x) as settings,
       (select row_to_json(x) from (select id from resources where is_active = true order by sort_order asc, created_at asc limit 1) x) as resource,
       (select row_to_json(x) from (select duration_minutes, buffer_minutes from plans where is_active = true order by sort_order asc, created_at asc limit 1) x) as plan`,
  );
  return rows[0];
}

function buildSlots(settings, plan) {
  return settings.slot_start_times.map((start, index) => {
    const serviceEnd = addMinutes(toDateTime("2026-01-01", start), plan.duration_minutes);
    return { id: `s${index + 1}`, index, label: `${start} - ${timeKey(serviceEnd)}`, start };
  });
}

function slotTimes(date, slot, plan) {
  const startAt = toDateTime(date, slot.start);
  const serviceEndAt = addMinutes(startAt, plan.duration_minutes);
  const endAt = addMinutes(serviceEndAt, plan.buffer_minutes);
  return { startAt, serviceEndAt, endAt };
}

async function listSlotControls(payload, event, admin) {
  const from = isoDate(payload.from) ? payload.from : dateKey(new Date());
  const to = isoDate(payload.to) ? payload.to : from;
  const { rows } = await getPool().query(
    `with s as (select slot_start_times, booking_open_days from store_settings order by created_at asc limit 1),
          r as (select id from resources where is_active = true order by sort_order asc, created_at asc limit 1),
          p as (select duration_minutes, buffer_minutes from plans where is_active = true order by sort_order asc, created_at asc limit 1)
     select
       (select row_to_json(s) from s) as settings,
       (select row_to_json(r) from r) as resource,
       (select row_to_json(p) from p) as plan,
       coalesce((select json_agg(x order by x.start_at) from (
         select id, reservation_code, contact_name, contact_phone, guest_count, total_price, status, start_at, service_end_at
         from reservations
         where resource_id = (select id from r) and status = any($1::reservation_status[])
           and start_at < $3::timestamptz + make_interval(mins => (select buffer_minutes from p)) and end_at > $2::timestamptz
       ) x), '[]'::json) as reservations,
       coalesce((select json_agg(x) from (
         select start_at, end_at, reason from resource_blocks
         where resource_id = (select id from r)
           and start_at < $3::timestamptz + make_interval(mins => (select buffer_minutes from p)) and end_at > $2::timestamptz
       ) x), '[]'::json) as blocks,
       coalesce((select json_agg(x) from (
         select target_date::text as target_date, slot_index, state, reason from slot_overrides
         where resource_id = (select id from r) and target_date >= $4::date and target_date <= $5::date
       ) x), '[]'::json) as overrides`,
    [ACTIVE_STATUSES, toDateTime(from, "00:00").toISOString(), toDateTime(to, "24:00").toISOString(), from, to],
  );
  const { settings, plan } = rows[0];
  const reservations = { rows: rows[0].reservations };
  const blocks = { rows: rows[0].blocks };
  const overrides = { rows: rows[0].overrides };
  {
    const slots = buildSlots(settings, plan);
    const today = todayKey();
    const openUntil = maxBookableDate(settings.booking_open_days);
    const overrideMap = new Map(overrides.rows.map((row) => [`${row.target_date}_${row.slot_index}`, row]));
    const days = daysBetween(from, to).map((date) => {
      const cells = slots.map((slot) => {
        const times = slotTimes(date, slot, plan);
        const booking = reservations.rows.find((row) => new Date(row.start_at) < times.endAt && new Date(row.service_end_at) > times.startAt);
        const block = blocks.rows.find((row) => new Date(row.start_at) < times.endAt && new Date(row.end_at) > times.startAt);
        const override = overrideMap.get(`${date}_${slot.index}`);
        let state = "closed";
        let reason = "closed";
        if (booking) {
          state = "booked";
          reason = "booked";
        } else if (times.startAt <= new Date()) {
          state = "ended";
          reason = "受付終了";
        } else if (block) {
          state = "blocked";
          reason = block.reason || "blocked";
        } else if (override?.state === "open") {
          state = "open";
          reason = override.reason || "open";
        } else if (override?.state === "closed") {
          state = "closed";
          reason = override.reason || "closed";
        }
        return {
          slotId: slot.id,
          slotIndex: slot.index,
          label: slot.label,
          state,
          reason,
          isPast: date < today || times.startAt <= new Date(),
          beyondOpenDays: date > openUntil,
          booking: booking ? {
            id: booking.id,
            reservationCode: booking.reservation_code,
            name: booking.contact_name,
            phone: booking.contact_phone,
            guestCount: booking.guest_count,
            totalPrice: booking.total_price,
          } : null,
        };
      });
      return { date, slots: cells };
    });
    return json(200, { ok: true, adminRole: admin.role, slots, days, bookingOpenDays: bookingOpenDays(settings.booking_open_days), maxBookableDate: openUntil }, event);
  }
}

async function setOne(payload, event, state, admin) {
  if (admin.role !== "owner") return json(403, { ok: false, error: "forbidden" }, event);
  if (!isoDate(payload.date)) return json(400, { ok: false, error: "invalid_date" }, event);
  if (payload.date < todayKey()) return json(400, { ok: false, error: "past_date", message: "過去日付は操作できません。" }, event);
  const index = slotIndex(payload.slotId);
  if (index < 0) return json(400, { ok: false, error: "invalid_slot" }, event);
  const client = await getPool().connect();
  try {
    const { resource, settings, plan } = await config(client);
    const slot = buildSlots(settings, plan)[index];
    if (!slot) return json(400, { ok: false, error: "invalid_slot", message: "枠が正しくありません。" }, event);
    const times = slotTimes(payload.date, slot, plan);
    if (times.startAt <= new Date()) return json(400, { ok: false, error: "past_slot", message: "受付終了済みの枠は操作できません。" }, event);
    const booked = await client.query(
      `select contact_name from reservations
       where resource_id = $1 and status = any($2::reservation_status[]) and start_at < $4 and end_at > $3
       limit 1`,
      [resource.id, ACTIVE_STATUSES, times.startAt.toISOString(), times.endAt.toISOString()],
    );
    if (booked.rowCount && state === "closed") {
      return json(409, { ok: false, error: "slot_has_booking", message: `${booked.rows[0].contact_name}様の予約が入っています。` }, event);
    }
    await client.query(
      `insert into slot_overrides (resource_id, target_date, slot_index, state, reason, note, created_by, updated_at)
       values ($1, $2::date, $3, $4, $5, $6, $7, now())
       on conflict (resource_id, target_date, slot_index)
       do update set state = excluded.state, reason = excluded.reason, note = excluded.note, updated_at = now()`,
      [resource.id, payload.date, index, state, payload.reason || null, payload.note || null, admin.id],
    );
    await audit(`slot_${state}`, admin, "slot_override", null, { date: payload.date, slotId: payload.slotId, state }, event);
    const openUntil = maxBookableDate(settings.booking_open_days);
    const warning = state === "open" && payload.date > openUntil
      ? `${bookingOpenDays(settings.booking_open_days)}日より先の日付です。枠は開けましたが、予約ページでは受付期間に入るまで表示されません。`
      : null;
    return json(200, { ok: true, changed: 1, skippedPast: 0, skippedBooked: 0, beyondOpenDays: warning ? 1 : 0, warning });
  } finally {
    client.release();
  }
}

async function bulk(payload, event, state, admin) {
  if (admin.role !== "owner") return json(403, { ok: false, error: "forbidden" }, event);
  if (!isoDate(payload.from) || !isoDate(payload.to)) return json(400, { ok: false, error: "invalid_range" }, event);
  const db = getPool();
  const { resource, settings, plan } = await config(db);
  const slots = buildSlots(settings, plan);
  const weekdays = Array.isArray(payload.weekdays) && payload.weekdays.length ? payload.weekdays.map(Number) : [0, 1, 2, 3, 4, 5, 6];
  const slotIds = Array.isArray(payload.slotIds) && payload.slotIds.length ? payload.slotIds : slots.map((s) => s.id);
  const now = new Date();
  const today = todayKey();
  const openUntil = maxBookableDate(settings.booking_open_days);
  let skippedPast = 0;
  const targets = [];
  for (const date of daysBetween(payload.from, payload.to).filter((d) => weekdays.includes(weekday(d)))) {
    for (const slotId of slotIds) {
      const index = slotIndex(slotId);
      const slot = slots[index];
      if (!slot) continue;
      const times = slotTimes(date, slot, plan);
      if (date < today || times.startAt <= now) {
        skippedPast += 1;
        continue;
      }
      targets.push({ date, index, times });
    }
  }
  // 予約の重なりと現在の開閉状態を1回で取得し、書き込みも1文にまとめる（往復回数を減らす）
  let writes = [];
  let skippedBooked = 0;
  let keptBooked = 0;
  let unchanged = 0;
  if (targets.length) {
    const rangeStart = new Date(Math.min(...targets.map((t) => t.times.startAt.getTime())));
    const rangeEnd = new Date(Math.max(...targets.map((t) => t.times.endAt.getTime())));
    const { rows } = await db.query(
      `select
         coalesce((select json_agg(x) from (
           select start_at, end_at from reservations
           where resource_id = $1 and status = any($2::reservation_status[]) and start_at < $4 and end_at > $3
         ) x), '[]'::json) as booked,
         coalesce((select json_agg(x) from (
           select target_date::text as target_date, slot_index, state from slot_overrides
           where resource_id = $1 and target_date >= $5::date and target_date <= $6::date
         ) x), '[]'::json) as overrides`,
      [resource.id, ACTIVE_STATUSES, rangeStart.toISOString(), rangeEnd.toISOString(), payload.from, payload.to],
    );
    const current = new Map(rows[0].overrides.map((o) => [`${o.target_date}_${o.slot_index}`, o.state]));
    for (const t of targets) {
      const isBooked = rows[0].booked.some((r) => new Date(r.start_at) < t.times.endAt && new Date(r.end_at) > t.times.startAt);
      const currentState = current.get(`${t.date}_${t.index}`) || "closed";
      if (state === "open" && isBooked) {
        skippedBooked += 1;
        continue;
      }
      if (currentState === state) {
        unchanged += 1;
        continue;
      }
      // 閉じる場合は予約済みの枠も閉じる（ご予約はそのまま。キャンセルが出ても再公開されない）
      if (state === "closed" && isBooked) keptBooked += 1;
      writes.push(t);
    }
  }
  if (writes.length) {
    await db.query(
      `insert into slot_overrides (resource_id, target_date, slot_index, state, reason, note, created_by, updated_at)
       select $1, t.d, t.i, $4, $5, $6, $7, now() from unnest($2::date[], $3::int[]) as t(d, i)
       on conflict (resource_id, target_date, slot_index)
       do update set state = excluded.state, reason = excluded.reason, note = excluded.note, updated_at = now()`,
      [resource.id, writes.map((t) => t.date), writes.map((t) => t.index), state, payload.reason || null, payload.note || null, admin.id],
    );
  }
  const changed = writes.length;
  const beyondOpenDays = state === "open" ? writes.filter((t) => t.date > openUntil).length : 0;
  await audit(`bulk_slots_${state}`, admin, "slot_override", null, { ...payload, state, changed, skippedBooked, keptBooked, unchanged, skippedPast, beyondOpenDays }, event);
  const warning = state === "open" && beyondOpenDays
    ? `${bookingOpenDays(settings.booking_open_days)}日より先の${beyondOpenDays}枠は、予約ページでは受付期間に入るまで表示されません。`
    : null;
  return json(200, { ok: true, changed, skippedBooked, keptBooked, unchanged, skippedPast, beyondOpenDays, warning });
}

async function closeDay(payload, event, admin) {
  const slots = ["s1", "s2", "s3", "s4"];
  return bulk({ ...payload, from: payload.date, to: payload.date, slotIds: slots }, event, "closed", admin);
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
    const admin = await currentAdmin(event);
    if (!admin) return json(401, { ok: false, error: "unauthorized" }, event);
    if (action === "listSlotControls") return await listSlotControls(payload, event, admin);
    if (action === "openSlot") return await setOne(payload, event, "open", admin);
    if (action === "closeSlot") return await setOne(payload, event, "closed", admin);
    if (action === "bulkOpenSlots") return await bulk(payload, event, "open", admin);
    if (action === "bulkCloseSlots") return await bulk(payload, event, "closed", admin);
    if (action === "closeDay") return await closeDay(payload, event, admin);
    return json(400, { ok: false, error: "unknown_action" }, event);
  } catch (error) {
    console.error("slot-control failed", error.code || error.message);
    return json(500, { ok: false, error: "slot_control_failed" }, event);
  }
};
