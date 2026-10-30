// テスト用に予約されたドメイン（RFC 2606 / 6761）。実在の顧客は受信できないため、
// これらの宛先の予約では Discord 通知・メール送信を行わない（本番での動作確認用）。
const TEST_DOMAINS = ["example.com", "example.net", "example.org"];
const TEST_TLDS = [".example", ".test", ".invalid"];

function isTestEmail(email) {
  const domain = String(email || "").trim().toLowerCase().split("@")[1] || "";
  if (!domain) return false;
  return TEST_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`)) || TEST_TLDS.some((tld) => domain.endsWith(tld));
}

module.exports = { isTestEmail };
