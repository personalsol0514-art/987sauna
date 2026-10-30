// 公開URLは Cloudflare の環境変数 SITE_ORIGIN で決める（独自ドメインに変えても、ここを変えずに済むように）
const OLD_SITE_ORIGIN = "https://987sauna-kuwana.netlify.app"; // 移行中の画面からの通信を受けるため残す
function siteOrigin() {
  return String(process.env.SITE_ORIGIN || OLD_SITE_ORIGIN).replace(/\/+$/, "");
}
// 切り替え直後は、古いURLで開いたままの画面からの通信も受ける
function trustedOrigins() {
  return new Set([siteOrigin(), OLD_SITE_ORIGIN, "http://localhost:8765", "http://127.0.0.1:8765"]);
}
module.exports = { siteOrigin, trustedOrigins };
