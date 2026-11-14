// スタッフのLINEグループ（通知用LINE「987サウナ」@120vngiz が参加）にお知らせを送る。
// 鍵（LINE_NOTIFY_TOKEN）は Cloudflare の画面で Secret として登録する。送り先グループは wrangler.toml に書く。
// 鍵が未登録なら送らずに記録だけ残す（予約や毎朝の処理は止めない）。
// 今は Cloudflare に鍵を置いていないため、毎朝の処理の返事に文面を入れ、呼び出し元のさくらVPSが代わりに送る。
const { getPool } = require("./db");
const { externalDeliveryEnabled } = require("./外部送信設定");

async function writeLog({ eventType, text, status, error }) {
  await getPool().query(
    `insert into notification_logs (channel, event_type, reservation_id, recipient, payload, status, attempts, last_error, sent_at)
     values ('line_group', $1, null, $2, $3, $4, 1, $5, case when $4 = 'sent' then now() else null end)`,
    [eventType, process.env.LINE_NOTIFY_GROUP_ID || null, JSON.stringify({ text }), status, error || null],
  ).catch(() => {});
}

async function pushLineGroup(text, eventType) {
  if (!externalDeliveryEnabled()) return null;
  const token = process.env.LINE_NOTIFY_TOKEN;
  const to = process.env.LINE_NOTIFY_GROUP_ID;
  if (!token || !to) {
    await writeLog({ eventType, text, status: "skipped", error: "LINE_NOTIFY_TOKEN or LINE_NOTIFY_GROUP_ID is not configured" });
    return "skipped";
  }
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: "text", text: String(text).slice(0, 4900) }] }),
    });
    if (!res.ok) throw new Error(`line ${res.status} ${(await res.text()).slice(0, 200)}`);
    await writeLog({ eventType, text, status: "sent" });
    return "sent";
  } catch (error) {
    await writeLog({ eventType, text, status: "failed", error: error.message });
    return "failed";
  }
}

module.exports = { pushLineGroup };
