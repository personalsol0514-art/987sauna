// エラーを LINE公式アカウント「mai」から かずや に送る。
// Worker の実体ごとのメモリは共有されないため、送信履歴は既存の通知ログで管理する。
import db from "./lib/db.js";

export async function notifyMai(text, key) {
  const token = process.env.MAI_LINE_TOKEN;
  const to = process.env.MAI_LINE_TO;
  if (!token || !to) {
    console.error("mai notify is not configured");
    return;
  }

  const dedupeKey = String(key || text.slice(0, 80)).slice(0, 200);
  try {
    await db.withPool(async () => {
      const client = await db.getPool().connect();
      try {
        await client.query("BEGIN");
        // 同時にエラーが起きても、重複と日次上限を判定してから1件ずつ送る。
        await client.query("SELECT pg_advisory_xact_lock(98762141)");
        const { rows } = await client.query(
          `select
             count(*) filter (where (sent_at at time zone 'Asia/Tokyo')::date = (now() at time zone 'Asia/Tokyo')::date)::int as today_count,
             count(*) filter (where payload->>'dedupe_key' = $1 and sent_at > now() - interval '6 hours')::int as recent_count
           from notification_logs
           where channel = 'line_mai' and status = 'sent' and sent_at > now() - interval '1 day'`,
          [dedupeKey],
        );
        if (rows[0].recent_count || rows[0].today_count >= 15) {
          await client.query("COMMIT");
          return;
        }

        const response = await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ to, messages: [{ type: "text", text: `【987サウナ予約サイト】\n${text}`.slice(0, 4900) }] }),
        });
        if (!response.ok) throw new Error(`LINE push returned ${response.status}`);
        await client.query(
          `insert into notification_logs
             (channel, event_type, recipient, payload, status, attempts, sent_at)
           values ('line_mai', 'system_error', $1, $2, 'sent', 1, now())`,
          [to, JSON.stringify({ dedupe_key: dedupeKey })],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
        await db.closePool();
      }
    });
  } catch (error) {
    console.error("mai notify failed", error?.code || error?.message);
  }
}
