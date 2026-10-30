// 返信を待たせない後処理（メール・Discord・スプレッドシートなど Google 経由で遅いもの）。
// 新形式の関数（context.waitUntil あり）では返信後も実行を続け、旧形式では従来どおり待ってから返す。
function afterResponse(event, label, task) {
  const run = () => Promise.resolve().then(task).catch((error) => console.error(`${label} failed`, error?.message));
  if (event && typeof event.defer === "function") {
    event.defer(run());
    return undefined;
  }
  return run();
}

// 新形式（Request / Context）の呼び出しを、旧形式（event を受け取るハンドラ）で処理する
async function runLegacyHandler(handler, req, context) {
  const event = {
    httpMethod: req.method,
    headers: Object.fromEntries(req.headers),
    body: req.method === "GET" || req.method === "HEAD" ? "" : await req.text(),
    defer: (promise) => context.waitUntil(promise),
  };
  const res = await handler(event);
  return new Response(res.body ?? "", { status: res.statusCode || 200, headers: res.headers || {} });
}

module.exports = { afterResponse, runLegacyHandler };
