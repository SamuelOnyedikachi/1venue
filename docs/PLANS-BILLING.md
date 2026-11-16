# Plans and billing (Phase 1)

Free, Premium and Organisation now carry real limits, every AI feature draws from one daily pool,
and hosts can pay in naira through Paystack hosted checkout (monthly or annual), with renewals charged
to the saved card. The credit wallet (`/wallet`) is a separate product and is unchanged.

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

| | Free | Premium | Organisation |
|---|---|---|---|
| Venues | 1 | 3 | 20 |
| Stage audience | 100 | 300 | 1000 |
| Meeting size | 25 | 50 | 50 |
| Speaker seats | 2 | 4 | 10 |
| AI points / day | 20 | 200 | 1000 |
| Uploads | 250 MB | 2 GB | 10 GB |
| Monthly / annual | – | ₦5,000 / ₦50,000 | ₦25,000 / ₦250,000 |

Links: Free gets `/v/name-venue`; paid plans get `/v/name`. The `slug3` (3–4 characters, ₦10,000) and
`slug2` (2 characters, ₦25,000) add-ons are one-off, perpetual, per venue, and only work on a paid plan.
AI weights: translate, ask, title, scripture 1; summaries, catch-up, “Write it for me” 2. In a room, AI
use is charged to the room's paying host (venue owner, else the signed-in host); each guest IP can spend
at most 30 points a day from a host's pool. The existing per-minute IP limit stays.

Settings layers (last wins): code defaults → env → the `app_settings` row saved from /admin. Admin saves
only store values that differ from env, so env changes still apply to untouched values. Per-account
overrides (venues, audience, meeting, speaker seats, AI points, upload MB) are set per user in /admin.
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
  the rest are archived (read-only, hidden, restored on re-upgrade); clean/short custom links are kept
  reserved and the venue falls back to a `-venue` link until the owner upgrades again.
- **Cancel:** renewal stops; access continues to period end, then Free (no grace).
- **Downgrade / interval switch:** scheduled with `POST /api/billing/change`; applied at period end by
  charging the new plan's price.
- **Admin grant:** status `comp`, optional end date, never charges a card. Every change goes to `plan_audit`.
- **Existing users:** everyone is Free, except users who had `plan=premium` (or the old `slug3`/`slug2`
  packages) who get Premium free for 3 months (`source=grandfather`). Old `slug3`/`slug2` users keep that tier
  as an add-on on each venue they owned. Grandfathered users have no saved card: they get the 5-day grace
  and a reminder at the end, then Free unless they pay from /billing.
- **Account deletion** is blocked while a plan payment is pending or under review (same idea as credits).

## Env (all optional; /admin wins)

```
MAX_AUDIENCE=1000                 # server hard ceiling for stage events (was 300)
PLAN_<FREE|PREMIUM|ORGANISATION>_<VENUES|AUDIENCE|MEETING|SPEAKER_SEATS|AI_DAILY|UPLOAD_MB|PRICE_MONTH_KOBO|PRICE_YEAR_KOBO>=…
AI_WEIGHT_<ASK|CATCHUP|TRANSLATE|TITLE|SUMMARY|FINETUNE|SCRIPTURE>=…
SLUG3_PRICE_KOBO=1000000
SLUG2_PRICE_KOBO=2500000
BILLING_GRACE_DAYS=5
AI_GUEST_PER_IP_DAILY=30
BILLING_WORKER=true               # set false on extra replicas if you prefer one renewer (claims are safe either way)
BILLING_RENEW_INTERVAL_MS=600000
```

`UPLOAD_USER_QUOTA_MB`, if set, is used as the Free upload default. `AI_FINETUNE_DAILY_LIMIT` still caps
“Write it for me” on top of the pool. The Paystack variables are unchanged (`PAYSTACK_SECRET_KEY`,
`PAYSTACK_WEBHOOK_SECRET`, `PAYSTACK_PASS_FEES_CONFIRMED`, `PAYSTACK_BASE_URL` for Bannk).

## Migrating

Migrations run on boot (`AUTO_MIGRATE` is on by default) or with `npm run migrate`. Back up the database
first: the migration rewrites `users.plan` values `slug3`/`slug2` to `premium` and creates grandfather
subscriptions. Testing renewals against Bannk needs the Bannk update that adds `charge_authorization`
and the reusable `authorization` object.
