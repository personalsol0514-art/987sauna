const { AsyncLocalStorage } = require("node:async_hooks");
const { Pool } = require("@neondatabase/serverless");

// Cloudflare Workers では、ある通信で開いた接続を別の通信で使えない。
// そのため接続は1回の処理ごとに作り、処理と後処理が全部終わってから閉じる
const scope = new AsyncLocalStorage();

function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  return url.includes("sslmode=") ? url : `${url}${url.includes("?") ? "&" : "?"}sslmode=verify-full`;
}

function getPool() {
  const current = scope.getStore();
  if (!current) throw new Error("getPool must be called inside withPool");
  if (!current.pool) {
    current.pool = new Pool({ connectionString: databaseUrl() });
    // 待機中の接続が切れたときの通知。受け手が無いと、処理全体が落ちた扱いになる
    current.pool.on("error", (error) => console.error("db pool error", error?.message));
  }
  return current.pool;
}

function withPool(run) {
  return scope.run({ pool: null }, run);
}

function closePool() {
  const current = scope.getStore();
  const pool = current?.pool;
  if (current) current.pool = null;
  return pool ? pool.end().catch(() => {}) : Promise.resolve();
}

module.exports = { getPool, withPool, closePool };
