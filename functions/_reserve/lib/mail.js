const { getPool } = require("./db");
const { isTestEmail } = require("./test-contact");
const { LINE_FRIEND_URL } = require("./共通設定");
const { externalDeliveryEnabled } = require("./外部送信設定");
const { siteOrigin } = require("./共通URL");

function yen(value) {
  return `${Number(value || 0).toLocaleString("ja-JP")}円`;
}

function manageUrl(token) {
  return `${siteOrigin()}/reserve/?token=${encodeURIComponent(token)}`;
}

function hasBbqRequest(row) {
  return Boolean(row.has_bbq_request) || String(row.options_text || "").includes("BBQ");
}

function bbqMailBlock(row) {
  if (!hasBbqRequest(row)) return "";
  return `
━━━━━━━━━━━━━━━━━━
■ BBQについて
━━━━━━━━━━━━━━━━━━
BBQのご希望を承りました。

BBQは併設の「スポーツマジック桑名」の
設備をご利用いただきます。

ご利用時間・料金などの詳細は、
当店より改めてご連絡いたします。
`;
}

function reservationMail(row) {
  const date = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "full" }).format(new Date(row.start_at));
  const start = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(row.start_at));
  const end = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(row.service_end_at));
  return {
    subject: `【987サウナ】ご予約を承りました（${row.reservation_code}）`,
    body: `${row.contact_name} 様

この度は987サウナをご予約いただき
ありがとうございます。
以下の内容で承りました。

━━━━━━━━━━━━━━━━━━
■ ご予約内容
━━━━━━━━━━━━━━━━━━
予約番号 : ${row.reservation_code}
ご利用日 : ${date}
時間     : ${start}〜${end}
プラン   : ${row.plan_name || "3時間プライベート"}
ご利用人数: ${row.guest_count}名様
ご料金   : ${yen(row.total_price)}（税込）
${bbqMailBlock(row)}

━━━━━━━━━━━━━━━━━━
■ ご予約の確認・キャンセル
━━━━━━━━━━━━━━━━━━
${manageUrl(row.manage_token)}

━━━━━━━━━━━━━━━━━━
■ お問い合わせ
━━━━━━━━━━━━━━━━━━
公式LINE: ${LINE_FRIEND_URL}

━━━━━━━━━━━━━━━━━━
■ 当日お持ちいただくもの
━━━━━━━━━━━━━━━━━━
・水着
・お飲み物
※ お水は無料でご提供しております

987サウナ KUWANA SAUNA
三重県桑名市西方小谷2411
スポーツマジック桑名内
TEL: 080-6419-3952`,
  };
}

function cancelMail(row, feeRate = 0) {
  return {
    subject: `【987サウナ】キャンセルを承りました（${row.reservation_code}）`,
    body: `${row.contact_name} 様

987サウナのご予約キャンセルを承りました。

予約番号 : ${row.reservation_code}
キャンセル規定 : ${feeRate}%（記録のみ・請求処理はありません）

またのご利用をお待ちしております。

お問い合わせは公式LINEからも承ります。
${LINE_FRIEND_URL}

987サウナ KUWANA SAUNA`,
  };
}

function reminderMail(row) {
  const date = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "full" }).format(new Date(row.start_at));
  const start = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(row.start_at));
  return {
    subject: `【987サウナ】明日のご予約リマインド（${row.reservation_code}）`,
    body: `${row.contact_name} 様

明日の987サウナご予約についてご案内いたします。

予約番号 : ${row.reservation_code}
ご利用日 : ${date}
開始時間 : ${start}

ご不明点は公式LINEからお問い合わせください。
${LINE_FRIEND_URL}

987サウナ KUWANA SAUNA`,
  };
}

async function writeLog({ channel, eventType, reservationId, recipient, payload, status, error, attempts = 1 }) {
  await getPool().query(
    `insert into notification_logs (channel, event_type, reservation_id, recipient, payload, status, attempts, last_error, sent_at)
     values ($1, $2, $3, $4, $5, $6, $8, $7, case when $6 = 'sent' then now() else null end)`,
    [channel, eventType, reservationId, recipient, JSON.stringify(payload || {}), status, error || null, attempts],
  );
}

async function sendGasMail({ to, subject, body, reservationId, eventType }) {
  if (!externalDeliveryEnabled()) return null;
  if (!to) return null;
  if (isTestEmail(to)) {
    await writeLog({ channel: "mail", eventType, reservationId, recipient: to, payload: { subject }, status: "skipped", error: "test contact" });
    return null;
  }
  const payload = { token: process.env.GAS_MAIL_TOKEN, action: "sendMail", to, subject, body };
  // GAS が混み合うと失敗することがあるため、3秒待って1回だけ再送する（返信後の処理なので客の待ち時間には影響しない）
  let attempts = 0;
  try {
    if (!process.env.GAS_MAIL_URL || !process.env.GAS_MAIL_TOKEN) throw new Error("GAS mail env is not configured");
    let lastError;
    for (attempts = 1; attempts <= 2; attempts += 1) {
      try {
        const res = await fetch(process.env.GAS_MAIL_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || "mail failed");
        await writeLog({ channel: "mail", eventType, reservationId, recipient: to, payload: { subject }, status: "sent", attempts });
        return data;
      } catch (error) {
        lastError = error;
        if (attempts < 2) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    throw lastError;
  } catch (error) {
    await writeLog({ channel: "mail", eventType, reservationId, recipient: to, payload: { subject }, status: "failed", error: error.message, attempts: Math.min(attempts, 2) || 1 });
    return null;
  }
}

async function sendReservationConfirmation(row) {
  const mail = reservationMail(row);
  return sendGasMail({ to: row.contact_email, reservationId: row.id, eventType: "reservation_confirmed", ...mail });
}

async function sendCancellationMail(row, feeRate) {
  const mail = cancelMail(row, feeRate);
  return sendGasMail({ to: row.contact_email, reservationId: row.id, eventType: "reservation_cancelled", ...mail });
}

async function sendReminderMail(row) {
  const mail = reminderMail(row);
  return sendGasMail({ to: row.contact_email, reservationId: row.id, eventType: "reservation_reminder", ...mail });
}

module.exports = { sendCancellationMail, sendGasMail, sendReminderMail, sendReservationConfirmation };
