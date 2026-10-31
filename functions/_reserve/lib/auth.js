const jwt = require("../vendor/npm.js").jwt;

const COOKIE_NAME = "kuwana_admin_session";
const SESSION_DAYS = 7;

function getJwtSecret() {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("ADMIN_JWT_SECRET must be 32 characters or longer");
  }
  return secret;
}

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function signAdminSession(user) {
  return jwt.sign(
    {
      sub: user.id,
      loginId: user.login_id,
      name: user.name,
      role: user.role,
    },
    getJwtSecret(),
    { expiresIn: `${SESSION_DAYS}d` },
  );
}

function verifyAdminSession(token) {
  return jwt.verify(token, getJwtSecret());
}

function getSessionFromEvent(event) {
  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || "");
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  return verifyAdminSession(token);
}

function sessionCookie(token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function requireRole(session, allowedRoles) {
  if (!session) return false;
  if (!allowedRoles || !allowedRoles.length) return true;
  return allowedRoles.includes(session.role);
}

module.exports = {
  COOKIE_NAME,
  clearSessionCookie,
  getSessionFromEvent,
  requireRole,
  sessionCookie,
  signAdminSession,
  verifyAdminSession,
};
