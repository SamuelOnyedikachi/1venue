/**
 * Short-link release. When an owner's paid plan lapses, their venue's 3/4-character link is parked
 * (venues.reserved_slug, link_parked_at). If no paid plan or payment brings it back within
 * SHORT_LINK_RELEASE_DAYS (default 60), the link is released: the slug becomes free for anyone to buy,
 * the add-on ends, an audit row is written and the owner is told. Notices go out 14 and 3 days before.
 *
 * Safe under many workers: every notice and the release itself is a conditional UPDATE … RETURNING,
 * so exactly one worker wins each step and re-running the sweep changes nothing.
 */
const { q } = require('../../../db');
const config = require('../../config');
const plans = require('../../lib/plans');
const codes = require('../../lib/codes');

const DAY = 86400000;
const NOTICE_DAYS = [14, 3];
function releaseDays() {
  const n = Number(process.env.SHORT_LINK_RELEASE_DAYS);
  return Number.isSafeInteger(n) && n >= 1 && n <= 3650 ? n : 60;
}
const isShort = (slug) => { const b = codes.slugifyBase(slug); return b.length >= 3 && b.length <= 4 && !/-venue$/.test(String(slug)); };
const releaseAt = (parkedAt) => (parkedAt ? new Date(new Date(parkedAt).getTime() + releaseDays() * DAY) : null);

function mail(row, title, intro) {
  if (!row.email) return;
  try {
    require('../mail/mailer').sendLater('shortLinkNotice', row.email, { name: row.display_name, title, intro, link: new URL('/billing', config.PUBLIC_URL || 'https://1venue.live').href });
  } catch (_) { /* mail is best effort */ }
}
const day = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** One pass. Returns { noticed, released, kept } for logs and tests. */
async function sweep(now = new Date()) {
  const out = { noticed: 0, released: 0, kept: 0 };
  const rows = (await q(`SELECT v.id, v.name, v.reserved_slug, v.link_parked_at, v.link_notice_days, v.owner_user_id, u.email, u.display_name
    FROM venues v JOIN users u ON u.id = v.owner_user_id
    WHERE v.reserved_slug IS NOT NULL AND v.link_parked_at IS NOT NULL ORDER BY v.link_parked_at LIMIT 500`)).rows;
  for (const r of rows) {
    if (!isShort(r.reserved_slug)) continue;
    const ent = await plans.entitlements(r.owner_user_id);
    if (plans.PAID.includes(ent.plan)) { out.kept++; continue; } // renewed: the plan sync puts the link back
    const at = releaseAt(r.link_parked_at);
    const left = Math.ceil((at.getTime() - now.getTime()) / DAY);
    const link = `1venue.live/v/${r.reserved_slug}`;
    if (at <= now) {
      const cutoff = new Date(now.getTime() - releaseDays() * DAY);
      const won = (await q(`UPDATE venues SET reserved_slug=NULL, slug_addon='none', slug_tier='none', link_parked_at=NULL, link_notice_days=NULL
        WHERE id=$1 AND reserved_slug=$2 AND link_parked_at <= $3 RETURNING id`, [r.id, r.reserved_slug, cutoff])).rows[0];
      if (!won) continue;
      await q('INSERT INTO plan_audit (user_id, actor_user_id, action, detail) VALUES ($1,NULL,$2,$3)',
        [r.owner_user_id, 'short_link_released', JSON.stringify({ venueId: r.id, slug: r.reserved_slug, parkedAt: new Date(r.link_parked_at).toISOString(), releaseDays: releaseDays() })]);
      mail(r, `Your short link ${link} was released`, `Your paid plan lapsed ${releaseDays()} days ago, so ${link} has been released and others can now buy it. ${r.name} keeps working on its -venue link.`);
      out.released++;
      continue;
    }
    const due = NOTICE_DAYS.filter((d) => left <= d).sort((a, b) => a - b)[0];
    if (due == null) continue;
    const won = (await q('UPDATE venues SET link_notice_days=$2 WHERE id=$1 AND reserved_slug=$3 AND (link_notice_days IS NULL OR link_notice_days > $2) RETURNING id', [r.id, due, r.reserved_slug])).rows[0];
    if (!won) continue;
    mail(r, `${link} will be released in ${left} day${left === 1 ? '' : 's'}`, `Your paid plan lapsed, so ${link} is parked. Renew before ${day(at)} to keep it; after that it is released and others can buy it.`);
    out.noticed++;
  }
  return out;
}
module.exports = { sweep, releaseDays, releaseAt, isShort, NOTICE_DAYS };
