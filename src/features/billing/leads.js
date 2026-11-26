const { q } = require('../../../db');
const config = require('../../config');
const { fail } = require('../wallet/rules');

const one = async (sql, args) => (await q(sql, args)).rows[0] || null;
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
const clean = (v, n) => String(v || '').trim().slice(0, n);

function salesEmail() {
  return String(process.env.SALES_EMAIL || '').trim() || (config.ADMIN_EMAILS && config.ADMIN_EMAILS[0]) || '';
}

async function create(body = {}, user = null) {
  const name = clean(body.name, 120);
  const email = clean(body.email, 200).toLowerCase();
  const organisation = clean(body.organisation, 160);
  const phone = clean(body.phone, 40);
  const teamSize = clean(body.teamSize || body.team_size, 80);
  const message = clean(body.message, 2000);
  if (name.length < 2) throw fail(400, 'Please enter your name');
  if (!emailOk(email)) throw fail(400, 'Please enter a valid email address');
  const row = await one(
    `INSERT INTO sales_leads (name, organisation, email, phone, team_size, message, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [name, organisation || null, email, phone || null, teamSize || null, message || null, user && user.id || null]
  );
  const to = salesEmail();
  const summary = [
    `${name}${organisation ? ' · ' + organisation : ''}`,
    email + (phone ? ' · ' + phone : ''),
    teamSize ? `Team / attendees: ${teamSize}` : '',
    message || '',
  ].filter(Boolean).join('\n');
  if (to) {
    try {
      require('../mail/mailer').sendLater('salesLead', to, {
        name, organisation, email, phone, teamSize, message, link: '/admin#sales-leads',
      });
    } catch (e) { console.warn('[sales] mail', e.message); }
  }
  try {
    const admins = config.ADMIN_EMAILS || [];
    if (admins.length) {
      const users = (await q('SELECT id FROM users WHERE lower(email) = ANY($1::text[])', [admins])).rows;
      const notify = require('../messages/notify');
      for (const u of users) {
        await notify.send(u.id, {
          style: 'detailed',
          text: `New Enterprise enquiry from ${name}. Our team will call them.\n\n${summary}`,
          links: [{ label: 'Open leads', href: '/admin#sales-leads' }],
          card: { type: 'event', kind: 'event', title: 'Enterprise enquiry', subtitle: name, link: '/admin#sales-leads' },
        });
      }
    }
  } catch (e) { console.warn('[sales] notify', e.message); }
  return { ok: true, message: 'Our team will call you' };
}

async function list({ limit = 100 } = {}) {
  const rows = (await q('SELECT * FROM sales_leads ORDER BY id DESC LIMIT $1', [Math.min(200, Math.max(1, Number(limit) || 100))])).rows;
  return rows.map((r) => ({
    id: Number(r.id), name: r.name, organisation: r.organisation, email: r.email, phone: r.phone,
    teamSize: r.team_size, message: r.message, userId: r.user_id, status: r.status, createdAt: r.created_at,
  }));
}

async function setStatus(id, status) {
  if (!['new', 'contacted', 'closed'].includes(status)) throw fail(400, 'Unknown status');
  const row = await one('UPDATE sales_leads SET status=$2 WHERE id=$1 RETURNING *', [id, status]);
  if (!row) throw fail(404, 'Lead not found');
  return { id: Number(row.id), status: row.status };
}

module.exports = { create, list, setStatus, salesEmail };
