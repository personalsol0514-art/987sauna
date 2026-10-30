const { audit, currentAdmin, json } = require('./lib/admin-api');

async function gas(action, data = {}) {
  const { GAS_MAIL_URL, GAS_MAIL_TOKEN } = process.env;
  if (!GAS_MAIL_URL || !GAS_MAIL_TOKEN) throw new Error('GAS connection is not configured');
  const response = await fetch(GAS_MAIL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: GAS_MAIL_TOKEN, action, ...data }),
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error(result.error || 'GAS request failed');
  return result;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' }, event);
  const origin = event.headers?.origin || event.headers?.Origin;
  const host = event.headers?.host || event.headers?.Host;
  if (origin && host) {
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).host === host; } catch { /* reject malformed origin */ }
    if (!sameOrigin) return json(403, { ok: false, error: 'invalid_origin' }, event);
  }

  const admin = await currentAdmin(event);
  if (!admin) return json(401, { ok: false, error: 'unauthorized' }, event);
  if (admin.role !== 'owner' || admin.login_id !== 'route') {
    return json(403, { ok: false, error: 'forbidden', message: 'LINE顧客管理はrouteアカウントのみ利用できます。' }, event);
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'invalid_json' }, event); }
  try {
    if (payload.action === 'list') {
      const result = await gas('listLineFriends');
      return json(200, { ok: true, contacts: result.contacts || [] }, event);
    }
    if (payload.action === 'update') {
      const userId = String(payload.userId || '');
      if (!/^U[0-9a-f]{32}$/i.test(userId)) return json(400, { ok: false, error: 'invalid_user_id' }, event);
      const usageStatus = String(payload.usageStatus || '');
      const tags = String(payload.tags || '').trim();
      const memo = String(payload.memo || '').trim();
      if (!['', '未確認', '検討中', '予約済み', '利用済み'].includes(usageStatus) || tags.length > 200 || memo.length > 1000) {
        return json(400, { ok: false, error: 'invalid_fields' }, event);
      }
      await gas('updateLineFriend', { userId, usageStatus, tags, memo });
      try { await audit('update_line_customer', admin, 'line_customer', userId, { usageStatus, tags, memoLength: memo.length }, event); }
      catch (error) { console.error('LINE customer audit failed:', error.message); }
      return json(200, { ok: true }, event);
    }
    return json(400, { ok: false, error: 'unknown_action' }, event);
  } catch (error) {
    console.error('LINE customer request failed:', error.message);
    return json(502, { ok: false, error: 'sheet_unavailable' }, event);
  }
};
