const { getPool } = require("./lib/db");
const { postDiscord } = require("./lib/discord");
const { sendReminderMail } = require("./lib/mail");
const { syncAllReservations, syncPayments } = require("./lib/sheet");
const { externalDeliveryEnabled } = require("./lib/外部送信設定");

exports.config = { schedule: "0 23 * * *" };

function jstDate(offsetDays = 0) {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + offsetDays);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(now);
}

function formatTime(value) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function hasBbqRequest(row) {
  return Boolean(row.has_bbq_request) || String(row.options_text || "").includes("BBQ");
}

function present(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function dailyReservationValue(row) {
  const lines = [
    present(row.contact_name) ? `👤 ${row.contact_name} 様` : "",
    present(row.contact_phone) ? `📞 ${row.contact_phone}` : "",
    present(row.guest_count) ? `👥 ${row.guest_count}名` : "",
    present(row.start_at) && present(row.service_end_at) ? `📅 ${formatTime(row.start_at)}〜${formatTime(row.service_end_at)}` : "",
    present(row.plan_name) ? `📋 ${row.plan_name}（${row.guest_count}名様）` : "",
    present(row.total_price) ? `💰 ${Number(row.total_price).toLocaleString("ja-JP")}円` : "",
    present(row.options_text) ? `🔥 ${row.options_text}` : "",
    present(row.note) ? `📝 ${row.note}` : "",
  ].filter(Boolean);
  return `${hasBbqRequest(row) ? "🍖 BBQ希望あり\n" : ""}${lines.join("\n")}`;
}

exports.handler = async () => {
  if (!externalDeliveryEnabled()) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "external_delivery_disabled" }) };
  const date = jstDate(0);
  const client = await getPool().connect();
  try {
    const settings = await client.query("select slot_start_times from store_settings order by created_at asc limit 1");
    const slots = settings.rows[0]?.slot_start_times || ["10:00", "13:30", "17:00", "20:30"];
    const reservations = await client.query(
      `select r.reservation_code, r.contact_name, r.contact_phone, r.guest_count, r.total_price, r.start_at, r.service_end_at, r.note,
              p.name as plan_name,
              coalesce(ro.options_text, '') as options_text,
              coalesce(ro.has_bbq_request, false) as has_bbq_request
       from reservations r
       join plans p on p.id = r.plan_id
       left join lateral (
         select
           string_agg(opt.name_snapshot, ' / ' order by opt.name_snapshot) as options_text,
           bool_or(opt.name_snapshot ilike 'BBQ%') as has_bbq_request
         from reservation_options opt
         where opt.reservation_id = r.id
       ) ro on true
       where r.status = 'confirmed'
         and (r.start_at at time zone 'Asia/Tokyo')::date = $1::date
       order by r.start_at asc`,
      [date],
    );
    const reservationFields = slots.map((start) => {
      const row = reservations.rows.find((r) => formatTime(r.start_at) === start);
      return {
        name: start,
        value: row ? dailyReservationValue(row) : "空き、または未開放",
        inline: false,
      };
    });
    const uncompleted = await client.query(
      `select count(*)::int as count
       from reservations
       where status = 'confirmed'
         and (start_at at time zone 'Asia/Tokyo')::date < $1::date`,
      [date],
    );
    const uncompletedCount = Number(uncompleted.rows[0]?.count || 0);
    const tomorrow = jstDate(1);
    const reminders = await client.query(
      `select r.*, p.name as plan_name,
              coalesce(ro.options_text, '') as options_text,
              coalesce(ro.has_bbq_request, false) as has_bbq_request
       from reservations r
       join plans p on p.id = r.plan_id
       left join lateral (
         select
           string_agg(opt.name_snapshot, ' / ' order by opt.name_snapshot) as options_text,
           bool_or(opt.name_snapshot ilike 'BBQ%') as has_bbq_request
         from reservation_options opt
         where opt.reservation_id = r.id
       ) ro on true
       where r.status = 'confirmed'
         and (r.start_at at time zone 'Asia/Tokyo')::date = $1::date
       order by r.start_at asc`,
      [tomorrow],
    );
    await Promise.allSettled(reminders.rows.map((row) => sendReminderMail(row)));
    if (reservations.rowCount > 0 || uncompletedCount > 0) {
      const hasBbqToday = reservations.rows.some(hasBbqRequest);
      const fields = reservations.rowCount > 0
        ? [
          ...reservationFields,
          ...(uncompletedCount ? [{ name: "未精算", value: `昨日以前の未完了予約が${uncompletedCount}件あります。`, inline: false }] : []),
        ]
        : [{ name: "未精算", value: `昨日以前の未完了予約が${uncompletedCount}件あります。`, inline: false }];
      await postDiscord({
        embeds: [{
          title: reservations.rowCount > 0 ? `📅 ${date} の予約${hasBbqToday ? " 🍖 BBQ希望あり" : ""}` : "未精算の確認",
          description: reservations.rowCount > 0
            ? `本日は ${reservations.rowCount}件 のご予約です。前日リマインドは ${reminders.rowCount}件 送信対象です。`
            : "本日の予約はありませんが、未精算の予約があります。",
          color: reservations.rowCount > 0 ? 3447003 : 16776960,
          fields,
          timestamp: new Date().toISOString(),
        }],
      }, null, reservations.rowCount > 0 ? "daily_reservation_digest" : "daily_uncompleted_digest");
    }
    const all = await client.query(
      `select r.*, p.name as plan_name,
              coalesce(ro.options_text, '') as options_text,
              coalesce(ro.has_bbq_request, false) as has_bbq_request
       from reservations r
       join plans p on p.id = r.plan_id
       left join lateral (
         select
           string_agg(opt.name_snapshot, ' / ' order by opt.name_snapshot) as options_text,
           bool_or(opt.name_snapshot ilike 'BBQ%') as has_bbq_request
         from reservation_options opt
         where opt.reservation_id = r.id
       ) ro on true
       order by r.start_at desc
       limit 1000`,
    );
    await syncAllReservations(all.rows);
    // 決済履歴シート：送り損ねた決済があれば書き足す
    const payments = await client.query(
      `select op.id, op.amount, op.method, op.paid_at, op.recorded_by_name, op.note,
              r.reservation_code, r.contact_name, r.start_at
       from onsite_payments op
       join reservations r on r.id = op.reservation_id
       where op.status = 'paid'
       order by op.paid_at asc nulls last
       limit 5000`,
    );
    await syncPayments(payments.rows);
    return { statusCode: 200, body: JSON.stringify({ ok: true, date, count: reservations.rowCount, reminders: reminders.rowCount }) };
  } finally {
    client.release();
  }
};
