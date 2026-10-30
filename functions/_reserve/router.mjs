// 予約・管理・精算の入口。処理本体は Netlify 時代のものをそのまま使うため、同じ形の event に変換して渡す。
import { handler as adminAuth } from "./admin-auth.js";
import { handler as adminReservations } from "./lib/admin-reservations-core.js";
import { handler as reservations } from "./lib/reservations-core.js";
import { handler as settlement } from "./settlement.js";
import { handler as slotControl } from "./slot-control.js";
import { handler as lineCustomers } from "./line-customers.js";
import { handler as lineWebhook } from "./line-webhook.js";
import { handler as cronDaily } from "./cron-daily.js";
import db from "./lib/db.js";
import { notifyMai } from "./mai.mjs";

const API = {
  "admin-auth": adminAuth,
  "admin-reservations": adminReservations,
  reservations,
  settlement,
  "slot-control": slotControl,
  "line-customers": lineCustomers,
  "line-webhook": lineWebhook,
};
const PAGES = {
  "/reserve/admin": "/reserve/admin/",
  "/reserve/admin/setup": "/reserve/admin/",
  "/reserve/admin/reset": "/reserve/admin/",
  "/reserve/admin/line-customers": "/reserve/admin/line-customers/",
};
const ENV_KEYS = ["DATABASE_URL", "ADMIN_JWT_SECRET", "ADMIN_SETUP_TOKEN", "ADMIN_RECOVERY_EMAIL", "DISCORD_WEBHOOK_URL", "GAS_MAIL_URL", "GAS_MAIL_TOKEN", "LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET", "OUTBOUND_DELIVERY_ENABLED", "SITE_ORIGIN", "MAI_LINE_TOKEN", "MAI_LINE_TO", "CRON_SECRET"];

function failure(message) {
  return new Response(JSON.stringify({ ok: false, error: "server_error", message }), { status: 500, headers: { "content-type": "application/json; charset=utf-8" } });
}

// 同じ長さでなくても時間差で鍵が漏れないよう、ハッシュ同士を比べる
async function sameSecret(a, b) {
  if (!a || !b) return false;
  const hash = async (v) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  const [x, y] = await Promise.all([hash(a), hash(b)]);
  return x.every((v, i) => v === y[i]);
}

async function runCron(request, waitUntil) {
  if (!(await sameSecret(request.headers.get("x-cron-secret"), process.env.CRON_SECRET))) return new Response("Forbidden", { status: 403 });
  return db.withPool(async () => {
    try {
      const res = await cronDaily({ httpMethod: "POST", headers: {}, body: "" });
      return new Response(res?.body ?? "", { status: res?.statusCode || 200 });
    } catch (error) {
      console.error("cron failed", error?.message);
      waitUntil(notifyMai(`毎朝の自動処理（Discordのまとめ・リマインド・シート更新）が失敗しました\n${String(error?.message || error).slice(0, 300)}`, "cron:throw"));
      return failure("毎朝の処理に失敗しました。");
    } finally {
      await db.closePool();
    }
  });
}

async function runApi(request, url, handler, waitUntil) {
  const deferred = [];
  const event = {
    httpMethod: request.method,
    path: url.pathname,
    headers: Object.fromEntries(request.headers),
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: request.method === "GET" || request.method === "HEAD" ? "" : await request.text(),
    isBase64Encoded: false,
    defer: (promise) => deferred.push(promise),
  };
  return db.withPool(async () => {
    let res;
    try {
      res = await handler(event);
    } catch (error) {
      // 例外のまま落とすと画面側が理由を出せないので、JSON で返す
      console.error("api failed", url.pathname, error?.code || error?.message);
      waitUntil(notifyMai(`予約サイトの ${url.pathname} でエラー\n${error?.code || ""} ${String(error?.message || error).slice(0, 300)}`, `api:${url.pathname}:${error?.code || error?.message}`));
      res = null;
    }
    if (res && (res.statusCode || 200) >= 500 && res.statusCode !== 503) {
      waitUntil(notifyMai(`予約サイトの ${url.pathname} が ${res.statusCode} を返しました\n${String(res.body || "").slice(0, 200)}`, `status:${url.pathname}:${res.statusCode}`));
    }
    // メール・Discord・シートの後処理が終わってから接続を閉じる
    waitUntil(Promise.allSettled(deferred).then(() => db.closePool()));
    if (!res) return failure("処理に失敗しました。時間をおいてもう一度お試しください。");
    return new Response(res.body ?? "", { status: res.statusCode || 200, headers: res.headers || {} });
  });
}

export async function handleReserve({ request, env, next, waitUntil }) {
  // Cloudflare の環境変数を、Netlify 時代の処理が読む process.env に渡す
  for (const key of ENV_KEYS) if (env[key] !== undefined) process.env[key] = env[key];
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "/reserve" && url.pathname !== "/reserve/") {
    url.pathname = "/reserve/";
    return Response.redirect(url.toString(), 301);
  }
  const api = path.match(/^\/reserve\/api\/([a-z-]+)$/);
  if (api) {
    if (api[1] === "cron-daily") return runCron(request, waitUntil);
    const handler = API[api[1]];
    if (!handler) return new Response("Not Found", { status: 404 });
    return runApi(request, url, handler, waitUntil);
  }
  if (PAGES[path]) {
    const target = new URL(url);
    target.pathname = PAGES[path];
    target.search = "";
    const asset = await env.ASSETS.fetch(new Request(target, request));
    const headers = new Headers(asset.headers);
    headers.set("x-robots-tag", "noindex, nofollow, noarchive");
    headers.set("cache-control", "no-store");
    return new Response(asset.body, { status: asset.status, headers });
  }
  return next();
}
