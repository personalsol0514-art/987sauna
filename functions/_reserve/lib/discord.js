const { getPool } = require("./db");
const { isTestEmail } = require("./test-contact");
const { externalDeliveryEnabled } = require("./外部送信設定");

const COLORS = {
  created: 5763719,
  cancelled: 15548997,
  daily: 3447003,
  warning: 16776960,
};

function yen(value) {
  return `${Number(value || 0).toLocaleString("ja-JP")}円`;
}

function timeRange(row) {
  const fmt = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${fmt.format(new Date(row.start_at))}〜${fmt.format(new Date(row.service_end_at))}`;
}

function dateFull(row) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "full" }).format(new Date(row.start_at));
}

function hasBbqRequest(row) {
  return Boolean(row.has_bbq_request) || String(row.options_text || "").includes("BBQ");
}

function present(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function field(name, value, inline = true) {
  if (!present(value)) return null;
  return { name, value: String(value), inline };
}

function compactFields(fields) {
  return fields.filter(Boolean);
}

async function writeLog({ eventType, reservationId, payload, status, error }) {
  await getPool().query(
    `insert into notification_logs (channel, event_type, reservation_id, recipient, payload, status, attempts, last_error, sent_at)
     values ('discord', $1, $2, null, $3, $4, 1, $5, case when $4 = 'sent' then now() else null end)`,
    [eventType, reservationId, JSON.stringify(payload || {}), status, error || null],
  );
}

async function postDiscord(payload, reservationId, eventType) {
  if (!externalDeliveryEnabled()) return null;
  try {
    if (!process.env.DISCORD_WEBHOOK_URL) throw new Error("DISCORD_WEBHOOK_URL is not configured");
    const res = await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`discord ${res.status}`);
    await writeLog({ eventType, reservationId, payload, status: "sent" });
  } catch (error) {
    await writeLog({ eventType, reservationId, payload, status: "failed", error: error.message });
  }
}

async function notifyReservationCreated(row) {
  if (!externalDeliveryEnabled()) return null;
  if (isTestEmail(row.contact_email)) return writeLog({ eventType: "reservation_created", reservationId: row.id, payload: {}, status: "skipped", error: "test contact" });
  const bbq = hasBbqRequest(row);
  const plan = row.plan_name ? `${row.plan_name}（${row.guest_count}名様）` : "";
  return postDiscord({
    embeds: [{
      title: `🆕 新規予約が入りました${bbq ? " 🍖 BBQ希望あり" : ""}`,
      color: COLORS.created,
      fields: compactFields([
        field("👤 予約者", present(row.contact_name) ? `${row.contact_name} 様` : "", true),
        field("📞 電話", row.contact_phone, true),
        field("👥 人数", present(row.guest_count) ? `${row.guest_count}名` : "", true),
        field("📅 日時", `${dateFull(row)} ${timeRange(row)}`, false),
        field("📋 プラン", plan, true),
        field("💰 金額", present(row.total_price) ? `${yen(row.total_price)}（現地決済）` : "", true),
        field("🔥 オプション", row.options_text, false),
        field("📝 備考", row.note, false),
      ]),
      footer: { text: `予約番号 ${row.reservation_code}` },
      timestamp: new Date().toISOString(),
    }],
  }, row.id, "reservation_created");
}

async function notifyReservationCancelled(row, feeRate) {
  if (!externalDeliveryEnabled()) return null;
  if (isTestEmail(row.contact_email)) return writeLog({ eventType: "reservation_cancelled", reservationId: row.id, payload: {}, status: "skipped", error: "test contact" });
  return postDiscord({
    embeds: [{
      title: feeRate >= 100 ? "【直前】予約がキャンセルされました" : "予約がキャンセルされました",
      color: COLORS.cancelled,
      fields: [
        { name: "予約者", value: `${row.contact_name} 様`, inline: true },
        { name: "電話", value: row.contact_phone || "-", inline: true },
        { name: "対象日時", value: timeRange(row), inline: false },
        { name: "キャンセル規定", value: `${feeRate}% ※請求なし`, inline: true },
      ],
      footer: { text: `予約番号 ${row.reservation_code}` },
      timestamp: new Date().toISOString(),
    }],
  }, row.id, "reservation_cancelled");
}

module.exports = { notifyReservationCancelled, notifyReservationCreated, postDiscord };
