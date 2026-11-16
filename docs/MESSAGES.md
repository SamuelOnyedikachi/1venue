# Messages (DMs, groups, meeting chats, calls)

One inbox at `/messages` for direct messages, standing groups, organisation team groups and the
chats of meetings you attended. Calls are short-lived LiveKit rooms. No end-to-end encryption.

## What ships (M1–M5)
- **M1 inbox**: `conversations` + `conversation_members` index existing data. DMs still live in
  `dm_messages`, in-meeting chat and sub-groups in `chat_messages`; meeting chats are *projected*
  (indexed, never copied) and become read-only when the room ends. Standing/org groups store rows in
  `chat_messages.conversation_id`. Allow-list for new DMs (contacts, org members, shared meetings or
  groups; per-user policy everyone/contacts/nobody). `/api/dm/with-user` enforces the same allow-list.
  Account deletion keeps the other side's history and shows "Deleted user".
- **M2**: user socket `/ws/me` (live delivery, typing, read receipts, presence), reactions, edit
  (15 min) and delete, block and report (admin queue in `/admin` → Message reports), per-plan history.
- **M3**: Web Push (VAPID). Disabled cleanly when keys are unset (the settings sheet says so).
- **M4**: audio calls (Free, 1:1), video and group calls (Premium/Organisation), ringing over the user
  socket + push, escalate to video or to an instant meeting. Calls never use wallet credits.
- **M5**: Meet menu in a thread: start an instant meeting (normal `/new` flow, credits as usual),
  schedule one (one-off or recurring series, Phase 2 email reminders), or share one of your venues.

## Plans (editable in /admin → Plans, features block)
| key | Free | Premium | Organisation |
|---|---|---|---|
| `callVideo` (1:1 video) | 0 | 1 | 1 |
| `groupMembers` | 8 | 32 | 64 |
| `callParticipants` (2 = 1:1 only) | 2 | 8 | 16 |
| `historyDays` (0 = forever) | 365 | 0 | 0 |

Env defaults: `PLAN_FREE_CALL_VIDEO`, `PLAN_FREE_GROUP_MEMBERS`, `PLAN_FREE_CALL_PARTICIPANTS`,
`PLAN_FREE_HISTORY_DAYS` (and the `PLAN_PREMIUM_*` / `PLAN_ORGANISATION_*` twins).

## Environment variables (all optional)
| var | default | meaning |
|---|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | unset | Web Push keys. Unset = push off, everything else works. |
| `VAPID_SUBJECT` | `mailto:admin@1venue.live` | contact for push services |
| `CALL_RING_TIMEOUT_MS` | 40000 | unanswered calls become "missed" (min 5000) |
| `CALL_MAX_MINUTES` | 240 | hard cap per call |
| `CALL_SWEEP` | on | `false` disables the stale-call sweeper |
| `MESSAGES_SEND_PER_MIN` | 30 | per-user send rate |
| `MESSAGES_NEW_DM_PER_HOUR_FREE` / `_PAID` | 5 / 30 | new chats started per hour |
| `MESSAGES_PURGE_GRACE_DAYS` | 30 | extra days kept after the longest member retention before deletion |
| `MESSAGES_RETENTION_PURGE` | on | `false` = only hide old messages, never delete |
| `MESSAGES_RETENTION_WORKER` | on | `false` disables the purge worker |
| `MESSAGES_RETENTION_INTERVAL_MS` | 21600000 | purge interval (6 h) |

Calls reuse the existing `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.

Generate VAPID keys once and keep them stable (changing them invalidates every subscription):
```
npx web-push generate-vapid-keys
```

## Retention
Free plan history is hidden after 12 months (`historyDays`). A message is only *deleted* when every
member's retention (plus the grace period) has passed, and never when any member keeps history
forever. The purge is idempotent. Meeting chats follow the meeting record, not this rule.

## Migrations (run automatically on boot, additive)
- Postgres: `src/features/messages/migrations/20261119090000_messages.sql`
- SQLite: `migrations/sqlite/011_messages.sql`

They add columns to `dm_messages` / `chat_messages`, merge duplicate signed-in DM threads (messages
move to the oldest thread) and add a unique pair index, then create `conversations`,
`conversation_members`, `user_blocks`, `message_reports`, `message_reactions`, `push_subscriptions`,
`user_presence`, `calls`, `call_participants`, and backfill DM conversations.

## Deploy
1. Back up the database (the DM de-duplication step rewrites duplicate thread ids).
2. `npm ci` (adds `web-push`).
3. Optional: set `VAPID_*` env vars.
4. Make sure the reverse proxy forwards WebSocket upgrades for **`/ws/me`** as well as `/`
   (Caddy/Traefik/Coolify do by default; nginx needs the `Upgrade`/`Connection` headers on that path).
5. Restart. Migrations run on boot. Check `/messages`, then `/admin` → Message reports.

## Notes and limits
- Meeting guests never get inbox threads; in-room DMs between signed-in users show up in the inbox.
- Scheduled-meeting invites go to members' account emails (the host does not see the addresses in the UI,
  but the invite list is stored on the scheduled meeting the host owns).
- The optional email digest of unread messages is not built yet.
- New groups are picked from people you already have a direct chat with; org team groups are automatic.
