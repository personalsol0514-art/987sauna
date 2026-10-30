// エラーを LINE公式アカウント「mai」から かずや に送る（全プロジェクト共通の決まり）。
// 同じエラーは6時間に1回、1日15通まで。この記憶はWorkerの実体ごとなので、目安として効く
const sent = new Map();
let day = "", count = 0;
const SIX_HOURS = 6 * 60 * 60 * 1000;

export async function notifyMai(text, key) {
  const token = process.env.MAI_LINE_TOKEN, to = process.env.MAI_LINE_TO;
  if (!token || !to) return;
  const now = Date.now();
  if (sent.get(key) > now - SIX_HOURS) return;
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
  if (today !== day) { day = today; count = 0; }
  if (count >= 15) return;
  sent.set(key, now); count++;
  try {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to, messages: [{ type: "text", text: `【987サウナ予約サイト】\n${text}`.slice(0, 4900) }] }),
    });
  } catch (error) {
    console.error("mai notify failed", error?.message);
  }
}
