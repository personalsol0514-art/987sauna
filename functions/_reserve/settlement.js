const { audit, currentAdmin, json } = require("./lib/admin-api");
const { getPool } = require("./lib/db");
const { updateReservation, upsertPayment } = require("./lib/sheet");

let optionColumnCache = null;

function optionalText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function optionalPrefectureCode(value) {
  const code = Number(value);
  return Number.isInteger(code) && code >= 1 && code <= 99 ? code : null;
}

async function optionColumns(client) {
  if (optionColumnCache) return optionColumnCache;
  const result = await client.query(
    `select column_name
     from information_schema.columns
     where table_schema = 'public'
       and table_name = 'options'
       and column_name = any($1::text[])`,
    [["is_request_only"]],
  );
  const names = new Set(result.rows.map((row) => row.column_name));
  optionColumnCache = {
    isRequestOnly: names.has("is_request_only"),
  };
  return optionColumnCache;
}

async function listOptions(event, adminOverride) {
  const admin = adminOverride || await currentAdmin(event);
  if (!admin) return json(401, { ok: false, error: "unauthorized" }, event);
  const client = await getPool().connect();
  try {
    const columns = await optionColumns(client);
    const result = await client.query(
      `select id, name, category, price, max_qty as "maxQty", note
       from options
       where is_active = true
         and ${columns.isRequestOnly ? "coalesce(is_request_only, false) = false" : "true"}
       order by category asc, sort_order asc, created_at asc`,
    );
    return json(200, { ok: true, options: result.rows }, event);
  } finally {
    client.release();
  }
}

async function recordSettlement(payload, event, adminOverride) {
  const admin = adminOverride || await currentAdmin(event);
  if (!admin) return json(401, { ok: false, error: "unauthorized" }, event);
  const amount = Number(payload.amount);
  if (!payload.reservationId || !Number.isFinite(amount) || amount < 0) {
    return json(400, { ok: false, error: "invalid_settlement" }, event);
  }
  const method = String(payload.method || "").trim() || "other";
  // 精算した店員さんのお名前（社労士向けの決済履歴に残す）
  const staffName = String(payload.staffName || "").replace(/[\s\u3000]+/g, " ").trim();
  if (!staffName) {
    return json(400, { ok: false, error: "staff_name_required", message: "精算担当者のお名前を入力してください。入力欄がない場合は、画面を再読み込みしてください。" }, event);
  }
  if ([...staffName].length > 60) {
    return json(400, { ok: false, error: "staff_name_too_long", message: "精算担当者のお名前は60文字以内で入力してください。" }, event);
  }
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const found = await client.query("select id, status from reservations where id=$1 for update", [payload.reservationId]);
    if (!found.rows[0]) {
      await client.query("rollback");
      return json(404, { ok: false, error: "not_found" }, event);
    }
    if (found.rows[0].status !== "confirmed") {
      await client.query("rollback");
      return json(409, { ok: false, error: "not_confirmed", message: "確定済みの予約のみ精算できます。" }, event);
    }
    const existingPayment = await client.query(
      "select id from onsite_payments where reservation_id = $1 and status = 'paid' limit 1",
      [payload.reservationId],
    );
    if (existingPayment.rowCount) {
      await client.query("rollback");
      return json(409, { ok: false, error: "already_paid", message: "この予約はすでに精算済みです。" }, event);
    }
    if (Object.prototype.hasOwnProperty.call(payload, "prefectureCode") ||
        Object.prototype.hasOwnProperty.call(payload, "referralSource") ||
        Object.prototype.hasOwnProperty.call(payload, "referralSourceOther")) {
      // 引数には型を明示する（$2 is null のように型が決まらない使い方をすると、Postgres が 42P08 で毎回失敗する。2026-10-29 本番で精算が通らなかった）
      await client.query(
        `update reservations
         set prefecture_code = case when $5::text = 'staff' and $2::smallint is null then prefecture_code else $2::smallint end,
             referral_source = case when $5::text = 'staff' and $3::text is null then referral_source else $3::text end,
             referral_source_other = case when $5::text = 'staff' and $4::text is null then referral_source_other else $4::text end,
             updated_at=now()
         where id=$1`,
        [
          payload.reservationId,
          optionalPrefectureCode(payload.prefectureCode),
          optionalText(payload.referralSource),
          optionalText(payload.referralSourceOther),
          admin.role,
        ],
      );
    }
    const payment = await client.query(
      `insert into onsite_payments (reservation_id, kind, amount, method, status, paid_at, recorded_by, recorded_by_name, note)
       values ($1, 'usage', $2, $3, 'paid', now(), $4, $5, $6)
       returning id, paid_at`,
      [payload.reservationId, amount, method, admin.id, staffName, payload.note || null],
    );
    await client.query(
      `update reservations set status='completed', total_price=$2, updated_at=now()
       where id=$1`,
      [payload.reservationId, amount],
    );
    await client.query(
      `insert into reservation_status_histories (reservation_id, from_status, to_status, changed_by, reason)
       values ($1, $2::reservation_status, 'completed', 'admin', 'settlement_recorded')`,
      [payload.reservationId, found.rows[0].status],
    );
    await client.query("commit");
    const updated = await getPool().query(
      `select r.*, p.name as plan_name, $2::text as payment_method
       from reservations r join plans p on p.id = r.plan_id
       where r.id = $1`,
      [payload.reservationId, method],
    );
    const reservation = updated.rows[0];
    if (reservation) {
      // 予約一覧の更新と決済履歴への追記は同時に送る（待ち時間を増やさない）
      await Promise.all([
        updateReservation(reservation),
        upsertPayment({
          ...payment.rows[0], amount, method, recorded_by_name: staffName, note: payload.note || null,
          reservation_code: reservation.reservation_code, contact_name: reservation.contact_name, start_at: reservation.start_at,
        }),
      ]);
    }
    await audit("record_settlement", admin, "reservation", payload.reservationId, { amount, method, staffName }, event);
    return json(200, { ok: true });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true }, event);
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" }, event);
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "invalid_json" }, event); }
  try {
    const admin = await currentAdmin(event);
    if (!admin) return json(401, { ok: false, error: "unauthorized" }, event);
    if (body.action === "listOptions") return listOptions(event, admin);
    if (body.action === "recordSettlement") return recordSettlement(body.payload || {}, event, admin);
    return json(400, { ok: false, error: "unknown_action" }, event);
  } catch (error) {
    console.error("settlement failed", error.code || error.message);
    return json(500, { ok: false, error: "settlement_failed" }, event);
  }
};
