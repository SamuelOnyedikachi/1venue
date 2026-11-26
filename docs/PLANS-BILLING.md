# Plans and billing (Phase 1)

> Phase 2 and 3 (branding, recurring, reminders, exports, analytics, badge, promotions, tickets, payouts,
> organisations, replays) and the Coolify deploy checklist: see [PHASE2-3.md](PHASE2-3.md).

Free, Pro, Business, Organisation and Enterprise carry real limits. Meetings and AI draw from one
credit wallet. Hosts can pay in naira through Paystack hosted checkout (monthly or annual), with renewals
charged to the saved card. Enterprise is talk-to-sales (`/upgrade`).

## Where things live

| What | File |
|---|---|
| Plan table, settings, entitlements, AI pool | `src/lib/plans.js` |
| Checkout, verify/settle, renewals, grace, admin | `src/features/billing/service.js` |
| API routes | `src/features/billing/routes.js` |
| Migrations | `src/features/billing/migrations/20261117090000_plans_billing.sql` (Postgres), `migrations/sqlite/008_plans_billing.sql` (SQLite) |
| Pages | `/upgrade`, `/billing`, `/admin` (Plans + User plans cards) |
| Tests | `test/plans-billing.test.js` |

## Defaults (editable in /admin, no redeploy)

| | Free | Pro | Business | Organisation | Enterprise |
|---|---|---|---|---|---|
| Venues | 1 | 3 | 10 | 20 | Custom |
| Stage audience | 100 | 300 | 500 | 1000 | Custom |
| Meeting size | 25 | 50 | 75 | 50 | Custom |
| Speaker seats | 2 | 4 | 6 | 10 | Custom |
| Credits each month | welcome once | 2,000 | 5,000 | 12,000 | Custom |
| Uploads | 250 MB | 2 GB | 5 GB | 10 GB | Custom |
| Monthly / annual | – | ₦15,000 / ₦150,000 | ₦35,000 / ₦350,000 | ₦75,000 / ₦750,000 | Talk to sales |

Links: Free gets `/v/name-venue`; paid plans get `/v/name` (5+ characters). Shorter links are one-off add-ons
per venue on a paid plan: `slug4` (4 characters, ₦10,000) and `slug3` (3 characters, ₦25,000; also allows 4).
Links are never shorter than 3 characters. A short link is kept while the owner's plan is active and
**released 60 days after it lapses** (see *Short-link release* below).
Meetings, AI and related media are billed from the same credit wallet. Rates are set by env and are not
shown on the site. Unused plan credits do not roll over beyond one month; purchased credits never expire.

Settings layers (last wins): code defaults → env → the `app_settings` row saved from /admin. Admin saves
only store values that differ from env, so env changes still apply to untouched values. Per-account
overrides (venues, audience, meeting, speaker seats, monthly credits, upload MB) are set per user in /admin.
Server ceilings always apply: `MAX_AUDIENCE` (default now **1000**) and `MAX_PARTICIPANTS` (default 50).

## Lifecycle

- **Upgrade / new plan:** `/upgrade` → `POST /api/billing/checkout` → Paystack hosted checkout (card only,
  so the authorization is reusable) → return to `/billing?reference=…` and/or `charge.success` webhook on the
  existing `/payments/paystack/webhook` → verify → plan active, fresh period from today (no proration).
- **Renewal:** an in-process worker (every 10 min, row-claimed so several replicas are safe) charges
  `POST /transaction/charge_authorization` for due subscriptions and re-verifies before extending the period
  from the old period end.
- **Failed renewal:** status `past_due`, plan kept for **5 days** of grace (retry at most daily, email on
  the first failure). After grace: plan expires to Free; the oldest venues up to the Free limit stay open,
  the rest are archived (read-only, hidden, restored on re-upgrade); clean/short custom links are parked
  and the venue falls back to a `-venue` link; they return on re-upgrade. Short (3/4-character) links are
  released 60 days after the lapse (see *Short-link release*).
- **Cancel:** renewal stops; access continues to period end, then Free (no grace).
- **Downgrade / interval switch:** scheduled with `POST /api/billing/change`; applied at period end by
  charging the new plan's price.
- **Admin grant:** status `comp`, optional end date, never charges a card. Every change goes to `plan_audit`.
- **Existing users:** everyone is Free, except users who had `plan=premium` (or an old short-link
  package) who get Pro free for 3 months (`source=grandfather`). Grandfathered users have no saved card: they get the 5-day grace
  and a reminder at the end, then Free unless they pay from /billing.
- **Account deletion** is blocked while a plan payment is pending or under review (same idea as credits).

## Env (all optional; /admin wins)

```
MAX_AUDIENCE=1000                 # server hard ceiling for stage events (was 300)
PLAN_<FREE|PRO|BUSINESS|ORGANISATION>_<VENUES|AUDIENCE|MEETING|SPEAKER_SEATS|INCLUDED_CREDITS|UPLOAD_MB|PRICE_MONTH_KOBO|PRICE_YEAR_KOBO>=…
CREDIT_PRICE_KOBO=1000
BILLING_WELCOME_CREDITS=100
BILLING_FREE_MINUTES=20
SALES_EMAIL=
LINK4_PRICE_KOBO=1000000          # 4-character link (old name SLUG3_PRICE_KOBO still works for this tier)
LINK3_PRICE_KOBO=2500000          # 3-character link (old name SLUG2_PRICE_KOBO still works for this tier)
SHORT_LINK_RELEASE_DAYS=60        # days after a plan lapses before a parked short link is released
BILLING_GRACE_DAYS=5
AI_GUEST_PER_IP_DAILY=30
BILLING_WORKER=true               # set false on extra replicas if you prefer one renewer (claims are safe either way)
BILLING_RENEW_INTERVAL_MS=600000
```

`UPLOAD_USER_QUOTA_MB`, if set, is used as the Free upload default. `AI_FINETUNE_DAILY_LIMIT` still caps
“Write it for me” on top of the pool. The Paystack variables are unchanged (`PAYSTACK_SECRET_KEY`,
`PAYSTACK_WEBHOOK_SECRET`, `PAYSTACK_PASS_FEES_CONFIRMED`, `PAYSTACK_BASE_URL` for Bannk).

## Short-link release

When a paid plan lapses (cancel, failed renewal after grace, admin downgrade) the venue's short link is
parked (`venues.reserved_slug`, `link_parked_at`) and the venue uses a `-venue` link. Renewing or buying any
paid plan within `SHORT_LINK_RELEASE_DAYS` (default 60) puts the link straight back. Otherwise the billing
worker's sweep (same interval as renewals, `billing/shortlinks.js`):

- emails the owner 14 and 3 days before release (`link_notice_days` records the last notice, so each goes once);
- on day 60 releases the link: `reserved_slug` cleared, the add-on ends (`slug_addon='none'`), a
  `short_link_released` row goes to `plan_audit`, and the owner gets a release email;
- the old `/v/<slug>` URL shows "this link is available" (`GET /api/venues/claimable/:slug`) and anyone on a
  paid plan can buy it.

Every step is a conditional `UPDATE … RETURNING`, so running the sweep on several replicas, or twice, sends
each notice once and releases once. The owner's billing page shows the release date of a parked link.

## Short-link tiers and saved prices

The add-ons used to be named `slug3` (3–4 characters, ₦10,000) and `slug2` (₦25,000). They are now `slug4`
(₦10,000) and `slug3` (₦25,000). Admin prices saved under the old keys are mapped by price when read
(old `slug3` → `slug4`, old `slug2` → `slug3`) and rewritten with a version marker on the next save. A
venue's tier lives in `venues.slug_addon` (migration 014); the original `slug_tier` column is kept.

## Migrating

Migrations run on boot (`AUTO_MIGRATE` is on by default) or with `npm run migrate`. Back up the database
first: the migration rewrites `users.plan` values `slug3`/`slug2` to `premium` and creates grandfather
subscriptions. Testing renewals against Bannk needs the Bannk update that adds `charge_authorization`
and the reusable `authorization` object.
