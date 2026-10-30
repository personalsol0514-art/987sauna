const { getSessionFromEvent } = require("./auth");
const { getPool } = require("./db");

const { siteOrigin, trustedOrigins } = require("./共通URL");

function json(statusCode, body, event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || "";
  const allowedOrigins = trustedOrigins();
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": allowedOrigins.has(origin) ? origin : siteOrigin(),
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-allow-credentials": "true",
    },
    body: JSON.stringify(body),
  };
}

async function currentAdmin(event, roles = []) {
  let session;
  try {
    session = getSessionFromEvent(event);
  } catch {
    return null;
  }
  if (!session) return null;
  const result = await getPool().query(
    "select id, login_id, name, role from admin_users where id = $1 and is_active = true limit 1",
    [session.sub],
  );
  const admin = result.rows[0] || null;
  if (!admin) return null;
  if (roles.length && !roles.includes(admin.role)) return null;
  return admin;
}

async function audit(action, admin, targetType, targetId, afterData, event) {
  await getPool().query(
    `insert into audit_logs (admin_user_id, action, target_type, target_id, after_data, ip_address)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      admin?.id || null,
      action,
      targetType || null,
      targetId || null,
      afterData ? JSON.stringify(afterData) : null,
      event?.headers?.["cf-connecting-ip"] || event?.headers?.["x-nf-client-connection-ip"] || event?.headers?.["x-forwarded-for"] || null,
    ],
  );
}

function maskEmail(email) {
  const value = String(email || "");
  const [name, domain] = value.split("@");
  if (!name || !domain) return "";
  return `${name.slice(0, 1)}***@${domain}`;
}

module.exports = { audit, currentAdmin, json, maskEmail };
