// Cloudflare Pages には定期実行が無いので、この小さな Worker が毎朝8時に予約サイトの処理を呼ぶ。
// 失敗したら LINE「mai」に通知する
export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      let problem = "";
      try {
        const res = await fetch(`${env.SITE_ORIGIN}/reserve/api/cron-daily`, { method: "POST", headers: { "x-cron-secret": env.CRON_SECRET } });
        if (!res.ok) problem = `毎朝の自動処理が ${res.status} を返しました\n${(await res.text()).slice(0, 300)}`;
      } catch (error) {
        problem = `毎朝の自動処理を呼び出せませんでした\n${String(error?.message || error).slice(0, 300)}`;
      }
      if (problem && env.MAI_LINE_TOKEN && env.MAI_LINE_TO) {
        await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: { Authorization: `Bearer ${env.MAI_LINE_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ to: env.MAI_LINE_TO, messages: [{ type: "text", text: `【987サウナ予約サイト】\n${problem}` }] }),
        });
      }
    })());
  },
};
