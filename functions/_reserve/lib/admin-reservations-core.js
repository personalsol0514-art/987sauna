const { audit, currentAdmin, json, maskEmail } = require("./admin-api");
const { getPool } = require("./db");
const { sendCancellationMail, sendReservationConfirmation } = require("./mail");
const { notifyReservationCancelled } = require("./discord");
const { updateReservation } = require("./sheet");
const { afterResponse } = require("./after-response");
const { createPhoneBooking } = require("./reservations-core");

// 枠を使っている予約。精算済み（completed）・来店なし（no_show）も、その時間は枠が埋まったままにする（先に精算しても二重予約にならないように）
const ACTIVE_STATUSES = ["pending", "confirmed", "checked_in", "completed", "no_show"];

function dateKey(value) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(value));
}

function timeKey(value) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function dayStartAt(date) {
  return new Date(`${date}T00:00:00+09:00`);
}

function nextDayStartAt(date) {
  const next = dayStartAt(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function blockReasonCode(reason) {
  const code = String(reason || "").trim();
  return ["weather", "safety", "maintenance", "private_event", "other"].includes(code) ? code : "other";
}

function rowToBooking(row, admin) {
  const staff = admin.role === "staff";
  return {
    id: row.id,
    reservationCode: row.reservation_code,
    number: row.reservation_code,
    date: dateKey(row.start_at),
    timeRange: `${timeKey(row.start_at)} - ${timeKey(row.service_end_at)}`,
    guestCount: row.guest_count,
    name: row.contact_name,
    kana: row.contact_kana,
    email: staff ? maskEmail(row.contact_email) : row.contact_email,
    phone: row.contact_phone,
    prefectureCode: staff ? null : row.prefecture_code,
    referralSource: staff ? null : row.referral_source,
    referralSourceOther: staff ? null : row.referral_source_other,
    totalPrice: row.total_price,
    optionsText: row.options_text || "",
    hasBbqRequest: Boolean(row.has_bbq_request) || String(row.options_text || "").includes("BBQ"),
    status: row.status,
    cancelledBy: row.cancelled_by,
    cancelReason: row.cancel_reason,
    note: row.note,
    createdAt: row.created_at,
    payment: row.paid_amount == null ? null : {
      amount: row.paid_amount,
      method: row.paid_method,
      paidAt: row.paid_at,
      staffName: row.staff_name || null,
    },
  };
}

async function listReservations(payload, event) {
  const admin = await currentAdmin(event);
  if (!admin) return json(401, { ok: false, error: "unauthorized" }, event);
  const staff = admin.role === "staff";
  const from = staff ? dateKey(new Date()) : (payload.from || "2000-01-01");
  const to = staff ? from : (payload.to || "2100-01-01");
  const result = await getPool().query(
    `select r.*,
            coalesce(ro.options_text, '') as options_text,
            coalesce(ro.has_bbq_request, false) as has_bbq_request,
            pay.paid_amount, pay.paid_method, pay.paid_at, pay.staff_name
     from reservations r
     left join lateral (
       select
         string_agg(opt.name_snapshot || case when opt.quantity > 1 then ' x' || opt.quantity::text else '' end, ' / ' order by opt.name_snapshot) as options_text,
         bool_or(opt.name_snapshot ilike 'BBQ%') as has_bbq_request
       from reservation_options opt
       where opt.reservation_id = r.id
     ) ro on true
     left join lateral (
       select op.amount as paid_amount, op.method as paid_method, op.paid_at, op.recorded_by_name as staff_name
       from onsite_payments op
       where op.reservation_id = r.id and op.status = 'paid'
       order by op.paid_at desc nulls last
       limit 1
     ) pay on true
     where (r.start_at at time zone 'Asia/Tokyo')::date >= $1::date
       and (r.start_at at time zone 'Asia/Tokyo')::date <= $2::date
     order by r.start_at desc
     limit 300`,
    [from, to],
  );
  return json(200, { ok: true, bookings: result.rows.map((row) => rowToBooking(row, admin)), role: admin.role }, event);
}

function feeRate(row) {
  const policy = row.policy_snapshot || { rules: [] };
  const minutesUntil = Math.floor((new Date(row.start_at).getTime() - Date.now()) / 60000);
  let rate = 0;
  for (const rule of [...(policy.rules || [])].sort((a, b) => b.minutesBefore - a.minutesBefore)) {
    if (minutesUntil <= rule.minutesBefore) rate = Math.max(rate, rule.feePercent);
  }
  return rate;
}

const STAFF_TODAY_ONLY = "スタッフは当日の予約だけ操作できます。";

// スタッフの画面には当日の予約しか出ないので、操作できるのも当日の予約だけにする
function staffMayTouch(admin, row) {
  return admin.role === "owner" || dateKey(row.start_at) === dateKey(new Date());
}

async function adminCancel(payload, event) {
  const admin = await currentAdmin(event);
  if (!admin) return json(401, { ok: false, error: "unauthorized" }, event);
  const db = getPool();
  const found = await db.query("select * from reservations where id = $1", [payload.id]);
  const row = found.rows[0];
  if (!row) return json(404, { ok: false, error: "not_found" }, event);
  if (!staffMayTouch(admin, row)) return json(403, { ok: false, error: "forbidden", message: STAFF_TODAY_ONLY }, event);
  if (row.status !== "confirmed") return json(409, { ok: false, error: "not_confirmed", message: "この予約はすでにキャンセル済みです。" }, event);
  const rate = feeRate(row);
  const fee = Math.round(row.total_price * rate / 100);
  const reason = payload.reason || "admin_cancel";
  // 状態の更新と履歴の記録を1文で行う（DBとの往復を減らす。確定中の予約だけが対象）
  const result = await db.query(
    `with upd as (
       update reservations
       set status='cancelled', cancelled_at=now(), cancelled_by='store', cancel_reason=$2, cancellation_fee=$3, updated_at=now()
       where id=$1 and status='confirmed'
       returning *
     ), hist as (
       insert into reservation_status_histories (reservation_id, from_status, to_status, changed_by, reason)
       select id, 'confirmed'::reservation_status, 'cancelled'::reservation_status, 'admin', $2 from upd
       returning id
     )
     select upd.*, p.name as plan_name from upd join plans p on p.id = upd.plan_id`,
    [row.id, reason, fee],
  );
  const updated = result.rows[0];
  if (!updated) return json(409, { ok: false, error: "not_confirmed", message: "この予約はすでにキャンセル済みです。" }, event);
  await afterResponse(event, "admin cancel notifications", () => Promise.allSettled([
    sendCancellationMail(updated, rate),
    notifyReservationCancelled(updated, rate),
    updateReservation(updated),
    audit("admin_cancel_reservation", admin, "reservation", row.id, { reason, fee }, event),
  ]));
  return json(200, { ok: true, cancelled: true, cancellationFee: fee, cancellationFeeRate: rate }, event);
}

async function bulkAdminCancel(payload, event) {
  const admin = await currentAdmin(event);
  if (!admin) return json(401, { ok: false, error: "unauthorized" }, event);
  if (admin.role !== "owner") return json(403, { ok: false, error: "forbidden" }, event);
  const ids = Array.isArray(payload.ids) ? payload.ids.filter(Boolean) : [];
  const reason = String(payload.reason || "").trim();
  const blockNewReservations = payload.blockNewReservations !== false;
  if (!ids.length) return json(400, { ok: false, error: "no_targets", message: "中止する予約を選択してください。" }, event);
  if (!reason) return json(400, { ok: false, error: "reason_required", message: "中止理由を選択してください。" }, event);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    // 対象の予約をまとめてキャンセルし、履歴も同じ文で記録する（1件ずつ往復しない）
    const result = await client.query(
      `with upd as (
         update reservations
         set status='cancelled', cancelled_at=now(), cancelled_by='store', cancel_reason=$2, cancellation_fee=0, updated_at=now()
         where id = any($1::uuid[]) and status='confirmed'
         returning *
       ), hist as (
         insert into reservation_status_histories (reservation_id, from_status, to_status, changed_by, reason)
         select id, 'confirmed'::reservation_status, 'cancelled'::reservation_status, 'admin', $2 from upd
         returning id
       )
       select upd.*, p.name as plan_name from upd join plans p on p.id = upd.plan_id`,
      [ids, reason],
    );
    const cancelledRows = result.rows;
    const cancelled = cancelledRows.map((row) => row.id);
    const skipped = ids.filter((id) => !cancelled.includes(id)).map((id) => ({ id, reason: "not_confirmed" }));
    const blockedDates = [];
    if (blockNewReservations && cancelledRows.length) {
      const targets = new Map();
      for (const row of cancelledRows) {
        const date = dateKey(row.start_at);
        targets.set(`${row.resource_id}_${date}`, { resourceId: row.resource_id, date });
      }
      for (const target of targets.values()) {
        const startAt = dayStartAt(target.date);
        const endAt = nextDayStartAt(target.date);
        const existingBlock = await client.query(
          `select 1 from resource_blocks
           where resource_id = $1
             and start_at < $3
             and end_at > $2
           limit 1`,
          [target.resourceId, startAt.toISOString(), endAt.toISOString()],
        );
        if (!existingBlock.rowCount) {
          await client.query(
            `insert into resource_blocks (resource_id, start_at, end_at, reason, note, created_by)
             values ($1, $2, $3, $4, $5, $6)`,
            [
              target.resourceId,
              startAt.toISOString(),
              endAt.toISOString(),
              blockReasonCode(reason),
              "一括中止に伴う新規予約受付停止",
              admin.id,
            ],
          );
        }
        blockedDates.push(target.date);
      }
    }
    await client.query("commit");
    const updated = cancelledRows;
    await afterResponse(event, "bulk cancel notifications", () => Promise.allSettled(updated.flatMap((row) => [
      sendCancellationMail(row, 0),
      notifyReservationCancelled(row, 0),
      updateReservation(row),
    ])));
    await audit("bulk_admin_cancel_reservations", admin, "reservation", null, {
      ids,
      reason,
      cancelled,
      skipped,
      blockNewReservations,
      blockedDates,
    }, event);
    return json(200, { ok: true, cancelled: cancelled.length, skipped, blockNewReservations, blockedDates }, event);
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function restoreReservation(payload, event) {
  const admin = await currentAdmin(event);
  if (!admin) return json(401, { ok: false, error: "unauthorized" }, event);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const found = await client.query("select * from reservations where id = $1 for update", [payload.id]);
    const row = found.rows[0];
    if (!row) {
      await client.query("rollback");
      return json(404, { ok: false, error: "not_found", message: "予約が見つかりません。" }, event);
    }
    if (!staffMayTouch(admin, row)) {
      await client.query("rollback");
      return json(403, { ok: false, error: "forbidden", message: STAFF_TODAY_ONLY }, event);
    }
    if (row.status !== "cancelled" || row.cancelled_by !== "store") {
      await client.query("rollback");
      return json(409, { ok: false, error: "not_restorable", message: "この予約は復元できません。" }, event);
    }
    const conflict = await client.query(
      `select reservation_code, contact_name
       from reservations
       where id <> $1 and resource_id = $2 and status = any($3::reservation_status[])
         and start_at < $5 and end_at > $4
       limit 1`,
      [row.id, row.resource_id, ACTIVE_STATUSES, row.start_at, row.end_at],
    );
    if (conflict.rowCount) {
      await client.query("rollback");
      return json(409, {
        ok: false,
        error: "slot_already_booked",
        message: `${conflict.rows[0].contact_name}様の別予約が入っているため復元できません。`,
      }, event);
    }
    await client.query(
      `update reservations
       set status='confirmed', cancelled_at=null, cancelled_by=null, cancel_reason=null, cancellation_fee=0, updated_at=now()
       where id=$1`,
      [row.id],
    );
    await client.query(
      `insert into reservation_status_histories (reservation_id, from_status, to_status, changed_by, reason)
       values ($1, 'cancelled', 'confirmed', 'admin', $2)`,
      [row.id, payload.reason || "restore_reservation"],
    );
    await client.query("commit");
    const updated = (await getPool().query(
      `select r.*, p.name as plan_name from reservations r join plans p on p.id = r.plan_id where r.id = $1`,
      [row.id],
    )).rows[0];
    if (updated) {
      await afterResponse(event, "restore notifications", () => Promise.allSettled([sendReservationConfirmation(updated), updateReservation(updated)]));
    }
    await audit("restore_reservation", admin, "reservation", row.id, { reason: payload.reason || "restore_reservation" }, event);
    return json(200, { ok: true, restored: true });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function noShow(payload, event) {
  const admin = await currentAdmin(event);
  if (!admin) return json(401, { ok: false, error: "unauthorized" }, event);
  const result = await getPool().query(
    `update reservations set status='no_show', updated_at=now()
     where id=$1 and status='confirmed'
       and ($2 = 'owner' or (start_at at time zone 'Asia/Tokyo')::date = (now() at time zone 'Asia/Tokyo')::date)
     returning id`,
    [payload.id, admin.role],
  );
  if (!result.rowCount) {
    return json(409, { ok: false, error: "not_confirmed", message: admin.role === "owner" ? "この予約は来店なしにできません。" : `この予約は来店なしにできません。${STAFF_TODAY_ONLY}` }, event);
  }
  const updated = await getPool().query(
    `select r.*, p.name as plan_name from reservations r join plans p on p.id = r.plan_id where r.id = $1`,
    [payload.id],
  );
  if (updated.rows[0]) await updateReservation(updated.rows[0]);
  await audit("reservation_no_show", admin, "reservation", payload.id, null, event);
  return json(200, { ok: true });
}

function optionalText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function optionalPrefectureCode(value) {
  const code = Number(value);
  return Number.isInteger(code) && code >= 1 && code <= 99 ? code : null;
}

async function updateReservationAttributes(payload, event) {
  const admin = await currentAdmin(event);
  if (!admin) return json(401, { ok: false, error: "unauthorized" }, event);
  if (!payload.id) return json(400, { ok: false, error: "reservation_required", message: "予約を指定してください。" }, event);
  const prefectureCode = optionalPrefectureCode(payload.prefectureCode);
  const referralSource = optionalText(payload.referralSource);
  const referralSourceOther = optionalText(payload.referralSourceOther);
  // 引数には型を明示する（$2 is null のように型が決まらない使い方をすると、Postgres が 42P08 で毎回失敗する。2026-10-29 本番で精算が通らなかった）
  const result = await getPool().query(
    `update reservations
     set prefecture_code = case when $5::text = 'staff' and $2::smallint is null then prefecture_code else $2::smallint end,
         referral_source = case when $5::text = 'staff' and $3::text is null then referral_source else $3::text end,
         referral_source_other = case when $5::text = 'staff' and $4::text is null then referral_source_other else $4::text end,
         updated_at = now()
     where id = $1
     returning *`,
    [payload.id, prefectureCode, referralSource, referralSourceOther, admin.role],
  );
  const row = result.rows[0];
  if (!row) return json(404, { ok: false, error: "not_found", message: "予約が見つかりません。" }, event);
  const updated = await getPool().query(
    `select r.*, p.name as plan_name from reservations r join plans p on p.id = r.plan_id where r.id = $1`,
    [row.id],
  );
  if (updated.rows[0]) await updateReservation(updated.rows[0]);
  await audit("update_reservation_attributes", admin, "reservation", row.id, {
    prefectureCode,
    referralSource,
    referralSourceOther,
  }, event);
  return json(200, { ok: true, booking: rowToBooking(updated.rows[0] || row, admin) }, event);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true }, event);
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" }, event);
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "invalid_json" }, event); }
  try {
    const action = body.action;
    const payload = body.payload || {};
    const admin = await currentAdmin(event);
    if (!admin) return json(401, { ok: false, error: "unauthorized" }, event);
    if (action === "createPhoneBooking") return await createPhoneBooking(payload, event, { admin });
    if (action === "listReservations") return await listReservations(payload, event);
    if (action === "adminCancel") return await adminCancel(payload, event);
    if (action === "bulkAdminCancel") return await bulkAdminCancel(payload, event);
    if (action === "restoreReservation") return await restoreReservation(payload, event);
    if (action === "noShow") return await noShow(payload, event);
    if (action === "updateReservationAttributes") return await updateReservationAttributes(payload, event);
    return json(400, { ok: false, error: "unknown_action" }, event);
  } catch (error) {
    console.error("admin-reservations failed", error.code || error.message);
    return json(500, { ok: false, error: "admin_reservations_failed" }, event);
  }
};
