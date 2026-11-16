# Phase 2 and 3: premium, commerce, organisations and replays

All features are gated through `src/lib/plans.js`. Plan limits, feature switches and platform settings
are edited in **/admin → Plans** (stored in `app_settings`, applied within 30 s, no redeploy).
Environment variables are only the fallback used when /admin has no value.

## What each plan gets (defaults)

| Feature (key) | Free | Premium | Organisation |
|---|---|---|---|
| Venue branding (`branding`): logo, colours, cover, about | – | ✓ | ✓ |
| Recurring events/meetings (`recurring`) | – | ✓ | ✓ |
| Email reminders 24 h + 1 h (`reminders`) / WhatsApp (`whatsapp`) | – | ✓ | ✓ |
| CSV/XLSX exports (`exports`), analytics dashboard (`analytics`) | – | ✓ | ✓ |
| Verified badge eligible (`badge`) | – | ✓ | ✓ |
| Self-serve promotions (`selfPromo`) | ✓ | ✓ | ✓ |
| Tickets and donations (`ticketing`) | – | – | ✓ |
| Cloud replays (`replays`), storage (`replayMB`) | – | – | ✓, 50 GB |
| Organisation members (`orgMembers`) | 0 | 0 | 25 |

Org members (owner/admin/moderator) inherit the org plan's features and its audience, meeting and
speaker-seat limits. Venues, AI points and uploads stay personal. Org venues belong to the org owner, so
the owner's venue limit applies.

## Admin settings (/admin)

* **Plans card**: per-plan limits and prices (Phase 1), then per-plan feature switches (1/0) and numbers,
  then platform settings: `feeBps` (default 500 = 5%), `promoDayKobo` (₦1,000/day), `promoMaxDays` (30),
  `promoApproval` (1: paid promotions wait for approval), `payoutMinKobo` (₦5,000), `ticketMaxPerOrder` (10),
  `donationMinKobo` (₦100), `reminderLeadA` (1440 min), `reminderLeadB` (60 min, 0 = off),
  `whatsappEnabled` (1, still needs env keys), `verifiedBoost` (1), `replayUploadMB` (500), `seriesMax` (52).
* **User plan card**: Grant badge / Remove badge (granting needs a plan with `badge`). Badges are dropped
  automatically when the plan lapses and come back when it returns.
* **Promotions to review, payouts and refunds** card: approve/reject paid promotions, mark payout requests
  paid (with transfer reference) or rejected (balance restored), and mark ticket/gift/promotion payments
  refunded *after* refunding the buyer in the Paystack dashboard (tickets cancelled, host balance reduced).

## Host pages

* `/host` (also in the user menu): Analytics + exports, Branding, Recurring, Promote, Tickets, Earnings,
  Organisation, Replays. `/host?invite=TOKEN` accepts an org invite.
* Event page: ticket tiers / free tickets / gifts, replay link, verified badge.
* `/replay/:id`: one replay page (video player, or embedded YouTube/Vimeo for links). No HLS.
* Create/edit event: the speaker-seat picker is capped to the plan's `speakerSeats` with an
  "Upgrade for more seats" link; the server clamps as well.

## Money flow

Tickets, gifts and promotions use Paystack hosted checkout (`1vc-…` references, verify-then-settle,
unique reference and provider id, shared webhook `/payments/paystack/webhook`). Platform fee is snapshot at
checkout: `fee = round(gross × feeBps / 10000)`, host net = gross − fee, written once to `host_ledger`.
Paystack's own fee is passed to the buyer (as for wallets). Payout requests debit the ledger; admins pay
manually and mark them paid. Wallet credits are **not** usable for promotions (see deviations).

## Reminders

A worker ticks every `REMINDER_TICK_MS` (60 s). Each send is claimed first in `reminder_sends`
(unique per target, lead, channel, recipient), so restarts, overlapping ticks and several app instances
never double-send. If the server was down past the 24 h point, only the 1 h reminder goes out.
Recipients: host, RSVPs and ticket holders for events; host and invitees for meetings.
WhatsApp uses the Meta Cloud API with an approved template (body params: event name, time, link) and is
off unless `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` are set and `whatsappEnabled` is 1. Users get
WhatsApp at the phone number on their account.

## Replays

Primary: **LiveKit Egress** (room composite → MP4 uploaded straight to your R2 bucket). Fallback: manual
upload (streamed to storage, never buffered in RAM) or an https link. Replay pages honour visibility
(public / unlisted / private), event tickets, and the owner's plan (lapsed plan = owner-only).

---

## New environment variables (all optional)

| Variable | Default | Purpose |
|---|---|---|
| `PLAN_<PLAN>_<FEATURE>` e.g. `PLAN_PREMIUM_TICKETING=1`, `PLAN_ORGANISATION_ORG_MEMBERS=25` | table above | Fallback feature switches |
| `PLATFORM_<SETTING>` e.g. `PLATFORM_FEE_BPS=500`, `PLATFORM_PROMO_DAY_KOBO=100000` | see admin list | Fallback platform settings |
| `REMINDER_WORKER` | on | `false` disables the reminder worker (e.g. on extra instances; safe either way) |
| `REMINDER_TICK_MS` | 60000 | Tick interval (min 15000) |
| `REMINDER_TIMEZONE` | Africa/Lagos | Time zone used in reminder text |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | – | Meta Cloud API credentials (both needed) |
| `WHATSAPP_TEMPLATE` / `WHATSAPP_TEMPLATE_LANG` | event_reminder / en | Approved template name and language |
| `WHATSAPP_API_VERSION` / `WHATSAPP_API_URL` | v21.0 / https://graph.facebook.com | Graph API |
| `LIVEKIT_EGRESS_ENABLED` | false | `true` turns on cloud recording (needs `STORAGE_DRIVER=s3`) |
| `LIVEKIT_API_URL` | from `LIVEKIT_URL` | HTTP(S) URL for the LiveKit API if different from the ws URL |
| `EGRESS_S3_ACCESS_KEY_ID` / `EGRESS_S3_SECRET_ACCESS_KEY` | `S3_*` keys | Separate R2 token for egress (recommended: write-only to the bucket) |
| `EGRESS_S3_ENDPOINT` / `EGRESS_S3_REGION` | `S3_ENDPOINT` / `S3_REGION` | Override the R2 endpoint seen by egress |
| `EGRESS_LAYOUT` | speaker | `speaker`, `grid` or `single-speaker` |
| `EGRESS_FILE_PREFIX` | replays | Object key prefix |
| `REPLAY_WORKER` / `REPLAY_POLL_MS` | on / 60000 | Polls egress status until the file is ready |
| `REPLAY_PUBLIC_REDIRECT` | on | With `S3_PUBLIC_BASE_URL`, media redirects to the bucket's public URL. Set `false` to always stream through the app (keeps ticket/private replays unguessable) |

## Migrations (additive, run on boot, SQLite + Postgres)

* `src/features/branding/migrations/20261118090000_phase2_premium.sql` (SQLite: `migrations/sqlite/009_phase2_premium.sql`):
  venue brand columns; user verified columns; `recurring_series`; `events.series_id`;
  `scheduled_meetings.series_id/invitees/reminders`; `reminder_sends`.
* `src/features/commerce/migrations/20261118100000_phase3_org_commerce.sql` (SQLite: `010_phase3_org_commerce.sql`):
  `organisations`, `org_members`, `org_invites`; `venues.org_id`, `materials.org_id`; promotion
  `owner_user_id/review_status/days/payment_reference`; `ticket_tiers`, `commerce_payments`, `tickets`,
  `host_ledger`, `payout_requests`, `replays`.

Only `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`. No drops or rewrites.
Tested on SQLite and on Postgres 18 (PGlite) with the full suite.

---

## Self-hosted LiveKit Egress (Coolify)

Egress is a separate service (`livekit/egress`). It joins rooms as a hidden participant, renders them in
headless Chrome, encodes MP4 and uploads to R2. It talks to the LiveKit server **through Redis**, so the
LiveKit server must use Redis too (the current single-node config has none).

1. **Redis**: in Coolify add a Redis resource (or a `redis:7-alpine` service) on the same Docker network as
   LiveKit. Set a password. Not exposed publicly.
2. **LiveKit server**: add to `livekit.yaml` and redeploy:
   ```yaml
   redis:
     address: redis:6379        # Coolify internal hostname of the Redis resource
     password: <redis password>
   ```
3. **R2 token for egress**: R2 → Manage API tokens → Object Read & Write, this bucket only. You can reuse
   the app's `S3_*` token; a separate one is cleaner (`EGRESS_S3_*`).
4. **Egress service** (Coolify → Docker Compose resource), using `docs/livekit/egress.yaml` and
   `docs/livekit/egress-compose.yml`:
   * image `livekit/egress:latest`, env `EGRESS_CONFIG_FILE=/etc/egress.yaml` (or `EGRESS_CONFIG_BODY`).
   * `api_key`/`api_secret` = the same `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` the app uses.
   * `ws_url: wss://rtc.1venue.live` (or the internal `ws://livekit:7880`).
   * `redis` = same Redis as the LiveKit server.
   * `s3` block with R2: `endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, `region: auto`,
     `bucket`, keys, `force_path_style: true`. (1venue also sends the upload target per request, so this
     block is a default.)
   * `cap_add: [SYS_ADMIN]` is recommended by LiveKit for Chrome's sandbox; no ports need exposing.
5. **CPU and memory**: room composite runs Chrome plus an H.264 encoder. Budget about **2–4 vCPU and
   2–4 GB RAM per concurrent recording** at 720p (more for 1080p). Set `cpu_cost` in `egress.yaml` so a
   busy node refuses new jobs rather than dropping frames. Run egress on its own container with CPU limits,
   ideally a separate host from LiveKit/1venue on your upgraded server, and scale by adding egress
   containers (they share the Redis queue).
6. **1venue app env**: `LIVEKIT_EGRESS_ENABLED=true`, `STORAGE_DRIVER=s3` with the R2 settings,
   `S3_PUBLIC_BASE_URL` (R2 custom domain, e.g. `https://files.1venue.live`) if you want direct playback;
   set `REPLAY_PUBLIC_REDIRECT=false` if ticketed or private replays must not be reachable by URL.
7. **Check**: host a live room → /host → Replays → "Record live room" with the room code → stop → status
   turns *ready* within a minute or so (the worker polls). Egress logs show `egress_complete`.

If egress is not configured, /host hides recording and offers upload or link instead.

---

## Coolify deploy checklist

1. Back up the database (Coolify → Postgres → Backups → Backup now).
2. Upload/push this build and redeploy the 1venue app. Migrations run on boot; watch for
   `[db] migrated 20261118090000_phase2_premium.sql` and `20261118100000_phase3_org_commerce.sql`.
3. Env: nothing new is required. Optional: `WHATSAPP_*`, `LIVEKIT_EGRESS_ENABLED` + egress service,
   `REPLAY_PUBLIC_REDIRECT`, `REMINDER_TIMEZONE`.
4. Make sure `PUBLIC_URL` is the live domain (Paystack callbacks and invite/reminder links use it) and the
   Paystack webhook is `https://<domain>/payments/paystack/webhook` (same as wallets).
5. Make sure SMTP is configured (org invites and reminders are email).
6. /admin → Plans: review feature switches, the 5% fee, promotion price and approval, payout minimum. Save.
7. Smoke test: /upgrade lists the new features; /host loads; create a ticket tier on an Organisation
   account and buy it with a Paystack test card (or Bannk sandbox with `PAYSTACK_BASE_URL`); check /host →
   Earnings shows net after fee; approve a paid promotion in /admin.
8. Optional: deploy Redis + LiveKit Egress as above, then set `LIVEKIT_EGRESS_ENABLED=true` and redeploy.

## Deviations

* Wallet credits cannot pay for promotions: the credit ledger only allows purchases today; promotions go
  through Paystack checkout.
* WhatsApp credentials are env-only (secrets); /admin only has the on/off switch.
* The verified badge belongs to the host account and shows on their events and venues; the Discover boost
  ranks events by verified hosts after live events.
* Refunds and payouts are recorded in 1venue but the money moves outside it (Paystack dashboard / bank).
