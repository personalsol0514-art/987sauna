const { verifyPassword, hashPassword } = require("./lib/password");
const crypto = require("crypto");
const {
  clearSessionCookie,
  getSessionFromEvent,
  sessionCookie,
  signAdminSession,
} = require("./lib/auth");
const { isTestEmail } = require("./lib/test-contact");
const { externalDeliveryEnabled } = require("./lib/外部送信設定");

const { siteOrigin } = require("./lib/共通URL");
const { getPool } = require("./lib/db");

const loginFailures = new Map();
const resetRequests = new Map();

function json(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function withCookie(statusCode, body, cookie) {
  return json(statusCode, body, { "set-cookie": cookie });
}

function outboundDisabledResponse() {
  return json(503, { ok: false, error: "outbound_mail_disabled", message: "テストモード中はスタッフ用ログインリンクを送信できません。" });
}

function clientIp(event) {
  return (
    event.headers["cf-connecting-ip"] ||
    event.headers["x-nf-client-connection-ip"] ||
    event.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function cleanLoginId(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidLoginId(value) {
  return /^[a-z0-9_-]+$/.test(value);
}

function publicUser(row) {
  return {
    id: row.id,
    loginId: row.login_id,
    name: row.name,
    role: row.role,
    // メールアドレスで招待した個人のアカウント（共用の staff などではない）
    personal: Boolean(row.email),
  };
}

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function cleanName(value) {
  return String(value || "").replace(/[\s\u3000]+/g, " ").trim();
}

function rateBucket(map, key, windowMs) {
  const now = Date.now();
  const current = map.get(key);
  if (!current || current.resetAt <= now) {
    const next = { count: 0, resetAt: now + windowMs };
    map.set(key, next);
    return next;
  }
  return current;
}

function loginLocked(ip) {
  return rateBucket(loginFailures, ip, 5 * 60 * 1000).count >= 10;
}

function recordLoginFailure(ip) {
  rateBucket(loginFailures, ip, 5 * 60 * 1000).count += 1;
}

function resetLocked(loginId) {
  return rateBucket(resetRequests, loginId, 5 * 60 * 1000).count >= 1;
}

function recordResetRequest(loginId) {
  rateBucket(resetRequests, loginId, 5 * 60 * 1000).count += 1;
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function randomToken() {
  return crypto.randomBytes(48).toString("base64url");
}

async function adminBySession(event) {
  let session;
  try {
    session = getSessionFromEvent(event);
  } catch {
    return null;
  }
  if (!session) return null;
  const result = await getPool().query(
    "select id, login_id, email, name, role, is_active, password_hash from admin_users where id = $1 and is_active = true limit 1",
    [session.sub],
  );
  return result.rows[0] || null;
}

async function countAdmins(db) {
  const result = await db.query("select count(*)::int as count from admin_users");
  return result.rows[0]?.count || 0;
}

async function sendAdminMail(to, subject, body) {
  if (!externalDeliveryEnabled()) throw new Error("test mode: outbound mail disabled");
  if (!process.env.GAS_MAIL_URL || !process.env.GAS_MAIL_TOKEN) throw new Error("GAS mail relay is not configured");
  const res = await fetch(process.env.GAS_MAIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: process.env.GAS_MAIL_TOKEN, action: "sendMail", to, subject, body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || "mail failed");
}

// 個人のアカウント（招待したスタッフ）は本人のメールアドレスへ、共用アカウントは代表のアドレスへ送る
async function sendRecoveryMail(loginId, resetUrl, personalEmail) {
  const to = personalEmail || process.env.ADMIN_RECOVERY_EMAIL;
  if (!to) throw new Error("ADMIN_RECOVERY_EMAIL is not configured");
  const requestedAt = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const body = `管理画面のパスワード再設定が
リクエストされました。

━━━━━━━━━━━━━━━━━━
対象アカウント : ${loginId}
リクエスト日時 : ${requestedAt}
━━━━━━━━━━━━━━━━━━

下記のURLから新しいパスワードを
設定してください。

${resetUrl}

※ このURLの有効期限は15分です
※ 一度使用すると無効になります

心当たりがない場合は、このメールを
破棄してください。パスワードは
変更されません。`;
  await sendAdminMail(to, "【987サウナ管理画面】パスワード再設定のご案内", body);
}

async function sendLoginLinkMail(user, loginUrl, first) {
  const intro = first
    ? "987サウナの管理画面に、スタッフとして登録されました。\n下のリンクを開くと、パスワードなしでログインできます。"
    : "987サウナの管理画面のログイン用リンクをお送りします。\n下のリンクを開くと、パスワードなしでログインできます。";
  const body = `${user.name} 様

${intro}

${loginUrl}

※ このリンクはあなた専用です。ほかの人に転送しないでください
※ 何度でも使えます。次回からも、このリンクを開くか、ログイン画面でメールアドレスだけ入れて「ログイン」を押すと入れます
※ 新しいリンクが届いたら、前のリンクは使えなくなります
※ 心当たりがない場合は、このメールを破棄してください`;
  await sendAdminMail(user.email, first ? "【987サウナ】管理画面へのご招待" : "【987サウナ】管理画面のログイン用リンク", body);
}

async function me(event) {
  const user = await adminBySession(event);
  if (!user) return withCookie(401, { ok: false, authenticated: false }, clearSessionCookie());
  return json(200, { ok: true, authenticated: true, user: publicUser(user) });
}

async function setupStatus(payload) {
  if (!process.env.ADMIN_SETUP_TOKEN || String(payload.token || "") !== process.env.ADMIN_SETUP_TOKEN) {
    return json(403, { ok: false, error: "invalid_setup_token" });
  }
  const count = await countAdmins(getPool());
  return json(200, { ok: true, setupRequired: count === 0 });
}

function validateSetupAccount(account) {
  const loginId = cleanLoginId(account.loginId);
  const name = String(account.name || "").trim();
  const password = String(account.password || "");
  const passwordConfirm = String(account.passwordConfirm || "");
  if (!name) return "表示名を入力してください。";
  if (!loginId || !isValidLoginId(loginId)) return "ログインIDは半角英数字・ハイフン・アンダースコアで入力してください。";
  if (password.length < 8) return "パスワードは8文字以上で入力してください。";
  if (password !== passwordConfirm) return "確認用パスワードが一致しません。";
  return null;
}

async function setup(payload) {
  if (!process.env.ADMIN_SETUP_TOKEN || String(payload.token || "") !== process.env.ADMIN_SETUP_TOKEN) {
    return json(403, { ok: false, error: "invalid_setup_token" });
  }
  const accounts = [
    { key: "routeOwner", role: "owner", defaultLoginId: "route" },
    { key: "storeOwner", role: "owner", defaultLoginId: "owner" },
    { key: "staff", role: "staff", defaultLoginId: "staff" },
  ].map(({ key, role, defaultLoginId }) => ({
    ...(payload[key] || {}),
    loginId: cleanLoginId((payload[key] || {}).loginId || defaultLoginId),
    role,
  }));

  for (const account of accounts) {
    const error = validateSetupAccount(account);
    if (error) return json(400, { ok: false, error: "invalid_account", message: error });
  }
  const ids = accounts.map((account) => account.loginId);
  if (new Set(ids).size !== ids.length) {
    return json(400, { ok: false, error: "duplicate_login_id", message: "ログインIDは3アカウントすべて別にしてください。" });
  }

  const client = await getPool().connect();
  try {
    await client.query("begin");
    const count = await countAdmins(client);
    if (count > 0) {
      await client.query("rollback");
      return json(409, { ok: false, error: "setup_already_completed" });
    }
    for (const account of accounts) {
      const passwordHash = await hashPassword(String(account.password));
      await client.query(
        `insert into admin_users (login_id, email, name, password_hash, role, is_active)
         values ($1, null, $2, $3, $4, true)`,
        [account.loginId, String(account.name).trim(), passwordHash, account.role],
      );
    }
    await client.query("commit");
    return json(200, { ok: true });
  } catch (error) {
    await client.query("rollback");
    return json(500, { ok: false, error: "setup_failed" });
  } finally {
    client.release();
  }
}

async function login(payload, event) {
  const ip = clientIp(event);
  const loginId = cleanLoginId(payload.loginId || payload.email);
  const password = String(payload.password || "");
  const fail = () => {
    recordLoginFailure(ip);
    return json(401, { ok: false, error: "invalid_credentials", message: "メールアドレス（ログインID）またはパスワードが違います。スタッフの方は、招待メールが届いたメールアドレスだけを入れて「ログイン」を押してください。" });
  };
  if (loginLocked(ip)) return json(429, { ok: false, error: "too_many_attempts", message: "ログイン試行が多すぎます。5分ほど時間をおいてください。" });
  if (!loginId) return fail();

  const result = await getPool().query(
    `select id, login_id, email, name, password_hash, role, is_active from admin_users
     where (lower(login_id) = lower($1) or lower(email::text) = lower($1)) and is_active = true limit 1`,
    [loginId],
  );
  const user = result.rows[0];
  if (!user) return fail();
  // メールで招待したスタッフは、メールアドレスだけで入れる（オーナーの判断）。オーナーと共用アカウントはパスワードが必要
  if (!isLinkStaff(user)) {
    if (!user.password_hash || !password) return fail();
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return fail();
  }

  loginFailures.delete(ip);
  await getPool().query("update admin_users set last_login_at = now(), updated_at = now() where id = $1", [user.id]);
  return withCookie(200, { ok: true, user: publicUser(user) }, sessionCookie(signAdminSession(user)));
}

async function changePassword(payload, event) {
  const current = await adminBySession(event);
  if (!current) return json(401, { ok: false, error: "unauthorized" });

  const targetLoginId = cleanLoginId(payload.targetLoginId || current.login_id);
  const newPassword = String(payload.newPassword || "");
  const newPasswordConfirm = String(payload.newPasswordConfirm || "");
  const currentPassword = String(payload.currentPassword || "");
  if (newPassword.length < 8) return json(400, { ok: false, message: "パスワードは8文字以上で入力してください。" });
  if (newPassword !== newPasswordConfirm) return json(400, { ok: false, message: "確認用パスワードが一致しません。" });

  const isSelf = targetLoginId === current.login_id;
  if (!isSelf && current.role !== "owner") return json(403, { ok: false, error: "forbidden" });
  if (isSelf) {
    const ok = await verifyPassword(currentPassword, current.password_hash || "");
    if (!ok) return json(403, { ok: false, message: "現在のパスワードが違います。" });
  }

  const passwordHash = await hashPassword(newPassword);
  const result = await getPool().query(
    "update admin_users set password_hash = $1, updated_at = now() where lower(login_id) = lower($2) and is_active = true returning id",
    [passwordHash, targetLoginId],
  );
  if (!result.rowCount) return json(404, { ok: false, error: "not_found" });
  return json(200, { ok: true });
}

async function requestPasswordReset(payload, event) {
  const loginId = cleanLoginId(payload.loginId);
  const generic = json(200, { ok: true, message: "ご案内のメールを送信しました。届かない場合は、オーナーにお問い合わせください。" });
  if (!loginId || resetLocked(loginId)) return generic;
  recordResetRequest(loginId);

  const result = await getPool().query(
    `select id, login_id, email, name, role from admin_users
     where (lower(login_id) = lower($1) or lower(email::text) = lower($1)) and is_active = true limit 1`,
    [loginId],
  );
  const user = result.rows[0];
  if (!user) return generic;
  if (isLinkStaff(user)) {
    if (!externalDeliveryEnabled()) return outboundDisabledResponse();
    try {
      await issueLoginLink(getPool(), user, event, false);
    } catch (error) {
      console.error("login link mail failed");
      return json(500, { ok: false, error: "mail_failed", message: "メール送信に失敗しました。" });
    }
    return generic;
  }

  const token = randomToken();
  await getPool().query(
    `insert into password_reset_tokens (admin_user_id, token_hash, expires_at, requested_ip)
     values ($1, $2, now() + interval '15 minutes', $3)`,
    [user.id, tokenHash(token), clientIp(event)],
  );

  const resetUrl = `${siteOrigin()}/reserve/admin/reset?token=${encodeURIComponent(token)}`;
  try {
    await sendRecoveryMail(user.login_id, resetUrl, user.email);
  } catch (error) {
    console.error("password reset mail failed");
    return json(500, { ok: false, error: "mail_failed", message: "メール送信に失敗しました。" });
  }
  return generic;
}

async function resetPassword(payload) {
  const token = String(payload.token || "");
  const newPassword = String(payload.newPassword || "");
  const newPasswordConfirm = String(payload.newPasswordConfirm || "");
  if (!token) return json(400, { ok: false, error: "missing_token" });
  if (newPassword.length < 8) return json(400, { ok: false, message: "パスワードは8文字以上で入力してください。" });
  if (newPassword !== newPasswordConfirm) return json(400, { ok: false, message: "確認用パスワードが一致しません。" });

  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await client.query(
      `select t.id, t.admin_user_id, u.login_id from password_reset_tokens t
       join admin_users u on u.id = t.admin_user_id and u.is_active = true and not (u.role = 'staff' and u.email is not null)
       where t.token_hash = $1 and t.used_at is null and t.expires_at > now()
       order by t.created_at desc limit 1
       for update of t`,
      [tokenHash(token)],
    );
    const row = result.rows[0];
    if (!row) {
      await client.query("rollback");
      return json(400, { ok: false, error: "invalid_or_expired_token", message: "リセットURLが無効、または期限切れです。" });
    }
    const passwordHash = await hashPassword(newPassword);
    await client.query("update admin_users set password_hash = $1, updated_at = now() where id = $2", [passwordHash, row.admin_user_id]);
    await client.query("update password_reset_tokens set used_at = now() where id = $1", [row.id]);
    await client.query("commit");
    return json(200, { ok: true, loginId: row.login_id });
  } catch (error) {
    await client.query("rollback");
    return json(500, { ok: false, error: "reset_failed" });
  } finally {
    client.release();
  }
}

// ---------------- スタッフ管理（オーナーのみ） ----------------
// メールアドレスで招待したスタッフ（パスワードなし・リンクで入る）
function isLinkStaff(row) {
  return row.role === "staff" && Boolean(row.email);
}

function staffStatus(row) {
  if (!row.is_active) return "stopped";
  if (isLinkStaff(row) && !row.last_login_at) return "invited";
  return "active";
}

async function audit(db, action, admin, targetId, afterData, event) {
  await db.query(
    `insert into audit_logs (admin_user_id, action, target_type, target_id, after_data, ip_address)
     values ($1, $2, 'admin_user', $3, $4, $5)`,
    [admin.id, action, targetId, JSON.stringify(afterData || {}), clientIp(event)],
  );
}

async function issueLoginLink(db, user, event, first) {
  if (!externalDeliveryEnabled()) throw new Error("test mode: outbound mail disabled");
  // 使えるのは最新の1本だけ。前のリンクは無効にしてから発行する
  await db.query("update staff_login_links set revoked_at = now() where admin_user_id = $1 and revoked_at is null", [user.id]);
  const token = randomToken();
  await db.query("insert into staff_login_links (admin_user_id, token_hash) values ($1, $2)", [user.id, tokenHash(token)]);
  // # 以降はサーバーにも参照元（Referer）にも送られないので、リンクがログに残らない
  const loginUrl = `${siteOrigin()}/reserve/admin#login=${token}`;
  // テスト用アドレス（example.com など）にはメールを送らず、URLだけ返す（本番での動作確認用）
  if (isTestEmail(user.email)) return { mailed: false, loginUrl };
  await sendLoginLinkMail(user, loginUrl, first);
  return { mailed: true };
}

async function linkLogin(payload, event) {
  const ip = clientIp(event);
  const token = String(payload.token || "");
  const invalid = () => {
    recordLoginFailure(ip);
    return json(401, { ok: false, error: "invalid_link", message: "このログイン用リンクは使えません。新しいリンクが届いている場合は、そちらを開いてください。スタッフの方は、メールアドレスだけ入れて「ログイン」を押しても入れます。" });
  };
  if (loginLocked(ip)) return json(429, { ok: false, error: "too_many_attempts", message: "ログイン試行が多すぎます。5分ほど時間をおいてください。" });
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) return invalid();
  // リンクは、送り直すか停止するまで何度でも使える（使えるのは最新の1本だけ。古いものは issueLoginLink で無効にしている）
  const result = await getPool().query(
    `with link as (
       update staff_login_links l set last_used_at = now()
       from admin_users u
       where l.token_hash = $1 and l.revoked_at is null
         and u.id = l.admin_user_id and u.is_active = true and u.role = 'staff'
       returning u.id
     )
     update admin_users set last_login_at = now(), updated_at = now()
     where id in (select id from link)
     returning id, login_id, email, name, role`,
    [tokenHash(token)],
  );
  const user = result.rows[0];
  if (!user) return invalid();
  loginFailures.delete(ip);
  return withCookie(200, { ok: true, user: publicUser(user) }, sessionCookie(signAdminSession(user)));
}

async function listStaff(current) {
  const result = await getPool().query(
    `select id, login_id, email, name, role, is_active, password_hash, last_login_at, invited_at, created_at
     from admin_users
     order by case role when 'owner' then 0 else 1 end, is_active desc, created_at asc`,
  );
  return json(200, {
    ok: true,
    users: result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      loginId: row.login_id,
      email: row.email,
      role: row.role,
      status: staffStatus(row),
      personal: Boolean(row.email),
      self: row.id === current.id,
      lastLoginAt: row.last_login_at,
      invitedAt: row.invited_at,
    })),
  });
}

async function inviteStaff(payload, event, current) {
  const name = cleanName(payload.name);
  const email = cleanEmail(payload.email);
  if (!name || [...name].length > 40) return json(400, { ok: false, message: "お名前を40文字以内で入力してください。" });
  if (!isValidEmail(email)) return json(400, { ok: false, message: "メールアドレスを確認してください。" });
  if (!externalDeliveryEnabled()) return outboundDisabledResponse();

  const client = await getPool().connect();
  try {
    await client.query("begin");
    const existing = await client.query(
      `select id, is_active from admin_users
       where lower(email::text) = $1 or lower(login_id) = $1 limit 1 for update`,
      [email],
    );
    const found = existing.rows[0];
    if (found) {
      await client.query("rollback");
      const message = !found.is_active
        ? "このメールアドレスは停止中のアカウントです。一覧から「再開」してください。"
        : "このメールアドレスはすでに登録されています。リンクをなくした場合は、一覧の「リンクを送り直す」を使ってください。";
      return json(409, { ok: false, error: "already_exists", message });
    }
    const inserted = await client.query(
      `insert into admin_users (login_id, email, name, password_hash, role, is_active, invited_at)
       values ($1, $2, $3, null, 'staff', true, now())
       returning id, email, name`,
      [email, email, name],
    );
    const user = inserted.rows[0];
    // メールが送れなかったときは招待ごと取り消す（あとから同じアドレスでやり直せるように）
    const sent = await issueLoginLink(client, user, event, true);
    await audit(client, "invite_staff", current, user.id, { name, email, mailed: sent.mailed }, event);
    await client.query("commit");
    return json(200, { ok: true, ...sent });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    console.error("invite staff failed", error.message);
    return json(500, { ok: false, error: "invite_failed", message: "招待メールを送れませんでした。メールアドレスを確認して、もう一度お試しください。" });
  } finally {
    client.release();
  }
}

async function staffTarget(db, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return null;
  const result = await db.query(
    "select id, login_id, email, name, role, is_active, password_hash, last_login_at from admin_users where id = $1 for update",
    [id],
  );
  return result.rows[0] || null;
}

async function resendLoginLink(payload, event, current) {
  if (!externalDeliveryEnabled()) return outboundDisabledResponse();
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const user = await staffTarget(client, payload.id);
    if (!user || !isLinkStaff(user)) {
      await client.query("rollback");
      return json(404, { ok: false, message: "対象のスタッフが見つかりません。" });
    }
    if (!user.is_active) {
      await client.query("rollback");
      return json(409, { ok: false, message: "停止中のスタッフです。「再開する」と新しいリンクを送ります。" });
    }
    const sent = await issueLoginLink(client, user, event, !user.last_login_at);
    await audit(client, "resend_staff_login_link", current, user.id, { email: user.email, mailed: sent.mailed }, event);
    await client.query("commit");
    return json(200, { ok: true, ...sent });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    console.error("resend login link failed", error.message);
    return json(500, { ok: false, message: "メールを送れませんでした。もう一度お試しください。" });
  } finally {
    client.release();
  }
}

async function setStaffActive(payload, event, current) {
  const active = payload.active === true;
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const user = await staffTarget(client, payload.id);
    // 停止・再開できるのはスタッフのアカウントだけ（オーナーは対象外）
    if (!user || user.role !== "staff") {
      await client.query("rollback");
      return json(404, { ok: false, message: "対象のスタッフが見つかりません。" });
    }
    if (active && isLinkStaff(user) && !externalDeliveryEnabled()) {
      await client.query("rollback");
      return outboundDisabledResponse();
    }
    await client.query(
      "update admin_users set is_active = $2, deactivated_at = case when $2 then null else now() end, updated_at = now() where id = $1",
      [user.id, active],
    );
    let sent = {};
    if (!active) {
      // 停止したら、ログイン用リンクと再設定URLをすべて無効にする
      await client.query("update staff_login_links set revoked_at = now() where admin_user_id = $1 and revoked_at is null", [user.id]);
      await client.query("update password_reset_tokens set used_at = now() where admin_user_id = $1 and used_at is null", [user.id]);
    } else if (isLinkStaff(user)) {
      sent = await issueLoginLink(client, user, event, false);
    }
    await audit(client, active ? "reactivate_staff" : "deactivate_staff", current, user.id, { name: user.name, loginId: user.login_id }, event);
    await client.query("commit");
    return json(200, { ok: true, ...sent });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// まだ一度もパスワードを設定していない招待だけ取り消せる（打ち間違いのやり直し用）
async function cancelInvite(payload, event, current) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const user = await staffTarget(client, payload.id);
    if (!user || !isLinkStaff(user) || user.last_login_at) {
      await client.query("rollback");
      return json(409, { ok: false, message: "取り消せるのは、まだ一度もログインしていない招待だけです。" });
    }
    await audit(client, "cancel_staff_invite", current, user.id, { name: user.name, email: user.email }, event);
    await client.query("delete from admin_users where id = $1", [user.id]);
    await client.query("commit");
    return json(200, { ok: true });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function logout() {
  return withCookie(200, { ok: true }, clearSessionCookie());
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }

  try {
    const action = body.action;
    const payload = body.payload || {};
    if (action === "me") return me(event);
    if (action === "setupStatus") return setupStatus(payload);
    if (action === "setup") return setup(payload);
    if (action === "login") return login(payload, event);
    if (action === "logout") return logout();
    if (action === "changePassword") return changePassword(payload, event);
    if (action === "requestPasswordReset") return requestPasswordReset(payload, event);
    if (action === "resetPassword") return resetPassword(payload);
    if (action === "linkLogin") return await linkLogin(payload, event);
    const current = await adminBySession(event);
    if (!current) return json(401, { ok: false, error: "unauthorized" });
    const staffActions = { listStaff, inviteStaff, resendLoginLink, setStaffActive, cancelInvite };
    if (staffActions[action]) {
      if (current.role !== "owner") return json(403, { ok: false, error: "forbidden" });
      if (action === "listStaff") return await listStaff(current);
      return await staffActions[action](payload, event, current);
    }
    return json(400, { ok: false, error: "unknown_action" });
  } catch (error) {
    console.error("admin-auth failed");
    return json(500, { ok: false, error: "admin_auth_failed" });
  }
};
