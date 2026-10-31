// パスワードの確認と作成はデータベース側（pgcrypto）で行う。
// JavaScript の bcrypt は1回約500ミリ秒の計算が要り、Cloudflare 無料プランの上限（10ミリ秒）に収まらないため。
// 既存のパスワードは $2b$ 形式で、pgcrypto は $2a$ しか読めない。計算方法は同じなので、見出しだけ読み替える
const { getPool } = require("./db");

function readable(hash) {
  return String(hash).replace(/^\$2b\$/, "$2a$");
}

async function verifyPassword(password, hash) {
  if (!hash) return false;
  const key = readable(hash);
  const result = await getPool().query("select $1::text = crypt($2::text, $1::text) as ok", [key, String(password)]);
  return result.rows[0]?.ok === true;
}

async function hashPassword(password) {
  const result = await getPool().query("select crypt($1::text, gen_salt('bf', 12)) as hash", [String(password)]);
  return result.rows[0].hash;
}

module.exports = { verifyPassword, hashPassword };
