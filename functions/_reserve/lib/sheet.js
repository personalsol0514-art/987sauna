const { getPool } = require("./db");
const { externalDeliveryEnabled } = require("./外部送信設定");

function fmtDate(value, options) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", ...options }).format(new Date(value));
}

function weekday(value) {
  return fmtDate(value, { weekday: "short" });
}

function time(value) {
  return fmtDate(value, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function statusLabel(status) {
  return {
    confirmed: "確定",
    cancelled: "キャンセル",
    completed: "完了",
    no_show: "来店なし",
    pending: "仮押さえ",
    expired: "期限切れ",
  }[status] || status || "";
}

// スプレッドシートは "=" などで始まる文字列を数式として扱うため、顧客入力は文字列として固定する
function sheetText(value) {
  return typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function rowFromReservation(row) {
  return sheetSafe({
    reservationCode: row.reservation_code,
    statusLabel: statusLabel(row.status),
    date: fmtDate(row.start_at, { year: "numeric", month: "2-digit", day: "2-digit" }).replaceAll("/", "-"),
    weekday: weekday(row.start_at),
    startTime: time(row.start_at),
    endTime: time(row.service_end_at),
    slotLabel: row.slot_label || "",
    name: row.contact_name,
    kana: row.contact_kana || "",
    phone: row.contact_phone,
    email: row.contact_email,
    guestCount: row.guest_count,
    planName: row.plan_name || "",
    planPrice: row.plan_price,
    optionsText: row.options_text || "",
    optionsTotal: row.options_total,
    totalPrice: row.total_price,
    paymentMethod: row.payment_method || (row.status === "completed" ? "精算済み" : "未精算"),
    prefecture: row.prefecture_name || String(row.prefecture_code || ""),
    referralSource: row.referral_source || "",
    note: row.note || "",
    createdAt: row.created_at ? fmtDate(row.created_at, { dateStyle: "short", timeStyle: "short" }) : "",
    cancelledAt: row.cancelled_at ? fmtDate(row.cancelled_at, { dateStyle: "short", timeStyle: "short" }) : "",
    cancellationFeeRate: row.cancellation_fee_rate || "",
  });
}

const METHOD_LABELS = { credit: "クレジット", qr: "QR決済", other: "その他" };

// 決済履歴シートの1行（精算1件）
function rowFromPayment(row) {
  return sheetSafe({
    paidAt: row.paid_at ? fmtDate(row.paid_at, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "",
    staffName: row.recorded_by_name || "",
    amount: Number(row.amount || 0),
    methodLabel: METHOD_LABELS[row.method] || row.method || "",
    reservationCode: row.reservation_code || "",
    customerName: row.contact_name || "",
    date: row.start_at ? fmtDate(row.start_at, { year: "numeric", month: "2-digit", day: "2-digit" }).replaceAll("/", "-") : "",
    addOns: String(row.note || "").replace(/^当日追加: /, ""),
    paymentId: row.id,
  });
}

function sheetSafe(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, sheetText(v)]));
}

async function gasCall(action, body) {
  if (!process.env.GAS_MAIL_URL || !process.env.GAS_MAIL_TOKEN) throw new Error("GAS env is not configured");
  const res = await fetch(process.env.GAS_MAIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: process.env.GAS_MAIL_TOKEN, action, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || "sheet api failed");
  return data;
}

async function gasPost(action, body, logMeta = {}) {
  if (!externalDeliveryEnabled()) return null;
  try {
    const data = await gasCall(action, body);
    await writeLog("sent", action, logMeta, null);
    return data;
  } catch (error) {
    // GAS が混み合うと失敗することがあるため、3秒待って1回だけ再試行する。
    // 追記の再試行は「更新」（予約番号・決済IDで上書き、なければ追記）で行い、行が二重にならないようにする
    const retryAction = { appendReservation: "updateReservation", updateReservation: "updateReservation", upsertPayment: "upsertPayment" }[action];
    if (retryAction) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const data = await gasCall(retryAction, body);
        await writeLog("sent", `${action}_retry`, logMeta, null);
        return data;
      } catch (retryError) {
        await writeLog("failed", action, logMeta, `${error.message} / retry: ${retryError.message}`);
        return null;
      }
    }
    await writeLog("failed", action, logMeta, error.message);
    return null;
  }
}

async function writeLog(status, eventType, logMeta, error) {
  await getPool().query(
    `insert into notification_logs (channel, event_type, reservation_id, recipient, payload, status, attempts, last_error, sent_at)
     values ('sheet', $1, $2, null, $3, $4, 1, $5, case when $4='sent' then now() else null end)`,
    [eventType, logMeta.reservationId || null, JSON.stringify(logMeta), status, error || null],
  );
}

async function appendReservation(row) {
  if (!externalDeliveryEnabled()) return null;
  return gasPost("appendReservation", { row: rowFromReservation(row) }, { reservationId: row.id, code: row.reservation_code });
}

async function updateReservation(row) {
  if (!externalDeliveryEnabled()) return null;
  return gasPost("updateReservation", { row: rowFromReservation(row) }, { reservationId: row.id, code: row.reservation_code });
}

async function syncAllReservations(rows) {
  if (!externalDeliveryEnabled()) return null;
  return gasPost("syncAll", { rows: rows.map(rowFromReservation) }, { count: rows.length });
}

async function upsertPayment(row) {
  if (!externalDeliveryEnabled()) return null;
  return gasPost("upsertPayment", { row: rowFromPayment(row) }, { paymentId: row.id, code: row.reservation_code });
}

async function syncPayments(rows) {
  if (!externalDeliveryEnabled()) return null;
  return gasPost("syncPayments", { rows: rows.map(rowFromPayment) }, { count: rows.length });
}

module.exports = { appendReservation, rowFromPayment, rowFromReservation, syncAllReservations, syncPayments, updateReservation, upsertPayment };
