const ORIGIN = 'https://987sauna-kuwana.netlify.app';
const API = '/reserve/api/reservations';
const HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' };
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8' } });
}
export async function onRequest({ request }) {
  const path = new URL(request.url).pathname;
  if (path === API) {
    if (request.method !== 'POST') return json(405, { ok: false, message: 'POSTのみ利用できます。' });
    let body;
    try {
      if (Number(request.headers.get('content-length')) > 4096) throw new Error('size');
      const text = await request.text();
      if (text.length > 4096) throw new Error('size');
      body = JSON.parse(text);
    } catch { return json(400, { ok: false, message: 'リクエストを確認してください。' }); }
    if (body?.action !== 'listAvailability') return json(403, { ok: false, message: 'テストページでは予約確定・照会・変更・キャンセルはできません。予約は登録されていません。' });
    try {
      const upstream = await fetch(ORIGIN + '/api/reservations', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'listAvailability', payload: body.payload || {}, source: '987sauna-reserve-preview' }),
      });
      return json(upstream.status, await upstream.json());
    } catch { return json(502, { ok: false, message: '空き枠を取得できませんでした。時間をおいて再読み込みしてください。' }); }
  }
  if (path !== '/reserve' && path !== '/reserve/') return new Response('Not found', { status: 404, headers: HEADERS });
  if (!['GET', 'HEAD'].includes(request.method)) return json(405, { ok: false });
  try {
    const upstream = await fetch(ORIGIN + '/', { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) throw new Error('upstream');
    let html = await upstream.text();
    const apiPattern = /const\s+api\s*=\s*\{\s*endpoint:\s*["']\/api\/reservations["']\s*\}\s*;/;
    if (!apiPattern.test(html) || !html.includes('</head>') || !html.includes('<body')) throw new Error('source_changed');
    html = html.replace(apiPattern, 'const api={endpoint:"' + API + '"};');
    html = html.replaceAll('public/', ORIGIN + '/public/');
    html = html.replace('</head>', '<meta name="robots" content="noindex,nofollow,noarchive"><style>.reserve-test-notice{position:relative;z-index:100001;padding:14px 20px;background:#fff3cf;color:#362c18;text-align:center;font:600 14px/1.7 sans-serif}.reserve-test-notice a{color:inherit;text-decoration:underline}</style><script>if(!location.hash){location.hash=location.search.includes("token=")?"manage":"booking_pages"}</script></head>');
    html = html.replace(/<body([^>]*)>/, '<body$1><aside class="reserve-test-notice" role="status">移管テストページ｜空き枠・入力画面の確認用です。予約確定・照会・キャンセルはできません。<br><a href="/">現在のホームページへ戻る</a></aside>');
    return new Response(request.method === 'HEAD' ? null : html, { headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "form-action 'none'; frame-ancestors 'self'", 'x-content-type-options': 'nosniff' } });
  } catch {
    return new Response('テストページを読み込めませんでした。公開中の予約画面の構成を確認してください。', { status: 502, headers: { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' } });
  }
}
