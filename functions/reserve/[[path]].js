const ORIGIN = 'https://987sauna-kuwana.netlify.app';
const API = '/reserve/api/reservations';
const HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' };
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8' } });
}
export async function onRequest({ request }) {
  const adminResponse = await handleAdmin(request);
  if (adminResponse) return adminResponse;
  const path = new URL(request.url).pathname;
  if (path === '/reserve' && ['GET','HEAD'].includes(request.method)) {
    const target=new URL(request.url);target.pathname='/reserve/';
    return new Response(null,{status:302,headers:{...HEADERS,location:target.toString()}});
  }
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
      const upstream = await fetch(ORIGIN + '/.netlify/functions/reservations', {
        method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'listAvailability', payload: body.payload || {}, source: '987sauna-reserve-preview' }),
      });
      return json(upstream.status, await upstream.json());
    } catch { return json(502, { ok: false, message: '空き枠を取得できませんでした。時間をおいて再読み込みしてください。' }); }
  }
  if (path.startsWith('/reserve/public/')) {
    if (!['GET','HEAD'].includes(request.method)) return json(405,{ok:false});
    try {
      const asset=await fetch(ORIGIN + path.slice('/reserve'.length), {redirect:'follow',signal:AbortSignal.timeout(15000)});
      if (path.endsWith('.js') && asset.ok) return new Response(request.method==='HEAD'?null:rebaseAdminRefs(await asset.text()),{headers:{...HEADERS,'content-type':'application/javascript; charset=utf-8','x-content-type-options':'nosniff'}});
      return new Response(request.method==='HEAD'?null:asset.body,{status:asset.status,headers:{...HEADERS,'content-type':asset.headers.get('content-type')||'application/octet-stream','x-content-type-options':'nosniff'}});
    } catch {return new Response('Asset unavailable',{status:502,headers:HEADERS});}
  }
  if (path !== '/reserve' && path !== '/reserve/') return new Response('Not found', { status: 404, headers: HEADERS });
  if (!['GET', 'HEAD'].includes(request.method)) return json(405, { ok: false });
  try {
    const upstream = await fetch(ORIGIN + '/', { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) throw new Error('upstream_status_' + upstream.status);
    let html = await upstream.text();
    const apiPattern = /const\s+api\s*=\s*\{\s*endpoint:\s*["']\/api\/reservations["']\s*\}\s*;/;
    if (!apiPattern.test(html) || !html.includes('</head>') || !html.includes('<body')) throw new Error('source_changed');
    html = html.replace(apiPattern, 'const api={endpoint:"' + API + '"};');
    html = html.replaceAll('public/', '/reserve/public/');
    html = html.replace('</head>', '<meta name="robots" content="noindex,nofollow,noarchive"><style>.reserve-test-notice{position:fixed;top:0;left:0;right:0;z-index:100001;padding:14px 20px;background:#fff3cf;color:#362c18;text-align:center;font:600 14px/1.7 sans-serif}.reserve-test-notice a{color:inherit;text-decoration:underline}</style><script>if(!location.hash){location.hash=location.search.includes("token=")?"manage":"booking_pages"}</script></head>');
    html = html.replace(/<body([^>]*)>/, '<body$1><aside class="reserve-test-notice" role="status">移管テストページ｜空き枠・入力画面の確認用です。予約確定・照会・キャンセルはできません。<br><a href="https://987sauna.pages.dev/">現在のホームページへ戻る</a></aside>');
    return new Response(request.method === 'HEAD' ? null : html, { headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "form-action 'none'; frame-ancestors 'self'", 'x-content-type-options': 'nosniff' } });
  } catch (error) {
    return new Response('診断: ' + error.message + '。テストページを読み込めませんでした。公開中の予約画面の構成を確認してください。', { status: 502, headers: { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' } });
  }
}

function rebaseAdminRefs(text) {
  return text.replace(/(["'\x60])\/api\//g, '$1/reserve/api/').replace(/(["'\x60])\/admin\b/g, '$1/reserve/admin').replace(/\/?public\//g, '/reserve/public/');
}
async function handleAdmin(request) {
  const path = new URL(request.url).pathname;
  const routes = {
    '/reserve/api/admin-auth': ['admin-auth', new Set(['login', 'me', 'logout', 'listStaff'])],
    '/reserve/api/admin-reservations': ['admin-reservations', new Set(['listReservations'])],
    '/reserve/api/slot-control': ['slot-control', new Set(['listSlotControls'])],
    '/reserve/api/settlement': ['settlement', new Set(['listOptions'])],
    '/reserve/api/line-customers': ['line-customers', new Set(['list'])],
  };
  if (Object.hasOwn(routes, path)) {
    if (request.method !== 'POST') return json(405, {ok:false, message:'POSTのみ利用できます。'});
    const origin=request.headers.get('origin');
    if(origin && origin!==new URL(request.url).origin)return json(403,{ok:false,message:'同じテストページから操作してください。'});
    if(!request.headers.get('content-type')?.includes('application/json'))return json(415,{ok:false,message:'JSON形式で送信してください。'});
    let body;
    try {const text=await request.text();if(text.length>16384)throw Error('size');body=JSON.parse(text);} catch {return json(400,{ok:false,message:'リクエストを確認してください。'});}
    const [endpoint, allowed] = routes[path];
    if (!allowed.has(body?.action)) return json(403, {ok:false,error:'preview_read_only',message:'管理画面の移管テスト中です。更新・精算・予約作成・通知・パスワード変更は実行できません。'});
    try {
      const headers={'content-type':'application/json'};
      const session=(request.headers.get('cookie')||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('kuwana_admin_session='));
      if(session)headers.cookie=session;
      const upstream=await adminFetch('/.netlify/functions/'+endpoint,{method:'POST',signal:AbortSignal.timeout(15000),headers,body:JSON.stringify(body)});
      const data=await upstream.json();
      const outHeaders=new Headers({...HEADERS,'content-type':'application/json; charset=utf-8','cache-control':'private, no-store',vary:'Cookie'});
      const cookie=upstream.headers.get('set-cookie');
      if(endpoint==='admin-auth' && cookie?.startsWith('kuwana_admin_session=')) outHeaders.set('set-cookie',cookie.replace(/;\s*Domain=[^;]+/ig,'').replace(/;\s*Path=\//i,'; Path=/reserve'));
      return new Response(JSON.stringify(data),{status:upstream.status,headers:outHeaders});
    } catch {return json(502,{ok:false,message:'管理APIに接続できませんでした。時間をおいて再読み込みしてください。'});}
  }
  const pages={
    '/reserve/admin':'/admin',
    '/reserve/admin/':'/admin',
    '/reserve/admin/line-customers':'/admin/line-customers',
  };
  if(!Object.hasOwn(pages,path))return null;
  if(!['GET','HEAD'].includes(request.method))return json(405,{ok:false});
  try {
    const upstream=await fetch(ORIGIN+pages[path],{redirect:'follow',signal:AbortSignal.timeout(15000)});
    if(!upstream.ok)throw Error('upstream');
    let html=await upstream.text();
    if(!html.includes('/api/')||!html.includes('</head>'))throw Error('source_changed');
    html=rebaseAdminRefs(html);
    html=html.replace('catch(e){showAuth("login")}}','catch(e){showAuth("login");if(e.status>=500)$("#loginError").textContent=e.response?.message||"管理APIに接続できません。"}}');
    html=html.replace('</head>','<meta name="robots" content="noindex,nofollow,noarchive"><style>body{padding-top:76px}.admin-test-notice{position:fixed;top:0;left:0;right:0;z-index:100001;background:#fff3cf;color:#362c18;padding:12px 18px;text-align:center;font:600 14px/1.7 sans-serif}.admin-test-notice a{text-decoration:underline;color:inherit}</style></head>');
    html=html.replace(/<body([^>]*)>/,'<body$1><aside class="admin-test-notice" role="status">管理画面の移管テスト｜既存アカウントでログイン・閲覧できます。更新・精算・予約作成・通知送信は停止中です。<br><a href="/reserve/">予約画面のテストへ</a></aside>');
    return new Response(request.method==='HEAD'?null:html,{headers:{...HEADERS,'content-type':'text/html; charset=utf-8','content-security-policy':"form-action 'none'; frame-ancestors 'self'",'x-content-type-options':'nosniff'}});
  } catch {return new Response('管理テスト画面を読み込めませんでした。',{status:502,headers:{...HEADERS,'content-type':'text/plain; charset=utf-8'}});}
}

async function adminFetch(path, init) {
  let target=new URL(path,ORIGIN);
  for(let hop=0;hop<4;hop++) {
    const response=await fetch(target.toString(),{...init,redirect:'manual'});
    if(![301,302,303,307,308].includes(response.status))return response;
    const location=response.headers.get('location');
    if(!location)throw Error('invalid_redirect');
    const next=new URL(location,target);
    if(next.origin!==ORIGIN)throw Error('unexpected_redirect_origin');
    target=next;
  }
  throw Error('too_many_redirects');
}
