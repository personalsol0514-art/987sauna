const crypto = require('node:crypto');

function response(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

function validSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64'); } catch { return false; }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function profileFor(userId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return {};
  const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return {};
  return res.json();
}

async function upsertFriend(lineEvent, displayName) {
  const { GAS_MAIL_URL, GAS_MAIL_TOKEN } = process.env;
  if (!GAS_MAIL_URL || !GAS_MAIL_TOKEN) throw new Error('GAS connection is not configured');
  const res = await fetch(GAS_MAIL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: GAS_MAIL_TOKEN,
      action: 'upsertLineFriend',
      userId: lineEvent.source.userId,
      displayName,
      eventType: lineEvent.type,
      eventId: lineEvent.webhookEventId || `${lineEvent.type}:${lineEvent.source.userId}:${lineEvent.timestamp}`,
      timestamp: lineEvent.timestamp,
      isUnblocked: lineEvent.follow?.isUnblocked === true,
    }),
  });
  const result = await res.json();
  if (!res.ok || result.ok !== true) throw new Error(`GAS upsert failed: ${result.error || res.status}`);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return response(405, { ok: false });
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return response(503, { ok: false, error: 'not_configured' });
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '', 'utf8');
  const signature = event.headers?.['x-line-signature'] || event.headers?.['X-Line-Signature'];
  if (!validSignature(rawBody, signature, secret)) return response(401, { ok: false });

  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return response(400, { ok: false }); }
  try {
    for (const lineEvent of payload.events || []) {
      if (!['follow', 'unfollow'].includes(lineEvent.type) || lineEvent.source?.type !== 'user' || !lineEvent.source.userId) continue;
      const profile = lineEvent.type === 'follow' ? await profileFor(lineEvent.source.userId).catch(() => ({})) : {};
      await upsertFriend(lineEvent, profile.displayName || '');
    }
  } catch (error) {
    console.error('LINE friend sheet update failed:', error.message);
    return response(500, { ok: false });
  }
  return response(200, { ok: true });
};

exports._test = { validSignature };
