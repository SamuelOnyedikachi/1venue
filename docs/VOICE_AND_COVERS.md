# Voice typing, captions, AI covers and promotions

## Voice typing (Replicate Whisper first)

Voice typing is **on by default** once the user accepts a one-time consent card. They can turn it off in
**Settings → Voice & captions**, or with "Turn off" on the card.

**Where it listens**

- The `/` command bar.
- Every text input and textarea.
- Date fields: the spoken date is parsed on the server, e.g. "next Friday at 6 pm" or "15th of December from 2 to 4".

**Where it never listens**

- Password, email, phone, number, OTP / one-time-code, card / payment and username fields.
- Anything disabled, read-only or marked `data-voice="off"`.
- The rules are in `public/js/voice-fields.js`.

### Engines, in order

| # | Engine | When |
|---|--------|------|
| 1 | **Whisper on Replicate**: `vaibhavs10/incredibly-fast-whisper` | `REPLICATE_API_TOKEN` is set and the user is under their daily cap |
| 2 | N-ATLaS / OpenAI-compatible Whisper (`STT_PRIMARY_*`, `STT_SECONDARY_*`) | Configured, and Replicate failed or is over the cap. Igbo goes to N-ATLaS first, because Whisper has no Igbo. |
| 3 | Browser Web Speech API (Chrome, Edge, Android; partial in Safari; not in Firefox) | No token, the cap was hit, the server said 429 or 503, or the browser has no MediaRecorder |

The app works without any token: everything falls back to the browser engine.

### Latency design

1. The browser runs a small energy-based VAD on the mic stream (50 ms ticks, adaptive noise floor) in `Segmenter`, in `public/js/voice.js`.
2. A clip is cut after **650 ms of silence**, or after `STT_SEGMENT_MAX_SECONDS` (5 s) of continuous speech. Silence is never uploaded.
3. Each clip is Opus at 24 kbps, about 3 KB per second.
4. Clips go to `POST /api/stt?mode=dictate`. Results are placed in order, by sequence number.
5. While a clip is in flight, the field shows a "…" placeholder, and the `/` key icon dances faster.
6. Typical turnaround is about 1–3 s after the user pauses.

**Language** is auto-detected. Settings → *Speech language* sends an optional hint. Igbo is sent as auto, because Whisper has no Igbo.

### Meetings

- **Unmuted:** the mic keeps publishing to the room. The bar uses a *clone* of the published track, so Android never opens the mic twice.
  - If live captions are already transcribing you, the bar reuses those lines. Speech is not paid for twice.
- **Muted:** the bar opens a **local-only** mic stream. Nothing is published to the room.
- **Android clash fallback:** if the meeting track ends while dictating, the session re-acquires the mic. Web Speech is skipped while a room mic is live.
- **Spoken scripture:** "John chapter three verse sixteen" becomes `John 3:16`. "Surah Al-Kahf verse ten" becomes `surah al kahf 10`.
  - These are only **suggestions**. The host taps to open them. Nothing is opened for everyone automatically.

### Caps and cost

Usage is counted in seconds of speech per UTC day, in the table `ai_daily_usage`.

| Env | Default | Meaning |
|-----|---------|---------|
| `STT_DAILY_SECONDS_PER_USER` | 1200 (20 min) | voice typing, per user (or per room guest) |
| `STT_DAILY_CAPTION_SECONDS_PER_USER` | 3600 (60 min) | live captions while you speak |
| `STT_DAILY_SECONDS_TOTAL` | 36000 (10 h) | whole server; protects the budget |

**Price.** incredibly-fast-whisper runs on an L40S at **US$0.000975 per second** of GPU time.

- A 2–5 s clip takes about 0.6–1 s, so **≈ US$0.012 per minute of speech**. That figure includes the per-call overhead.
- Per active user per day:
  - Typical use (1–2 min of dictation): about **US$0.01–0.03**.
  - Dictation cap: **US$0.24**.
  - Caption cap: **US$0.72**.
- Server cap: about **US$7/day** at most.

Over a cap, the client switches to Web Speech for 6 h (stored in sessionStorage).

The cheaper `openai/whisper` (T4, ~US$0.0008 per run) can be used through `STT_REPLICATE_MODEL`, but it takes about 15 s per clip.

## AI covers

**Flow:** Create event → Cover → **Design with AI**.

- It also runs automatically when "Write it for me" fills the title, and once when the cover step scrolls into view.
- **Model:** `black-forest-labs/flux-schnell`, 16:9, webp, 4 steps, with a text-free prompt (`src/features/covers/prompt.js`).
- **Count:** `AI_COVER_OPTIONS` images (2) per generation, and `AI_COVER_DAILY_LIMIT` generations (10) per user per day.
- **Cost:** about US$0.003 per image, so at most about US$0.06 per user per day.
- **What is saved:** options stay in server memory for 30 min. Only the **picked** one is stored. It becomes the event cover, and is also saved to Materials as "Cover · <title>".
- **Colours:** "Write it for me" also picks a matching event colour pair from the palette (`src/lib/palette.js`).

## Promotions

Admins pick events or posts in **/admin → Promotions**. Each promotion has:

- start and end dates;
- placements: `discover`, `feed`, `venues` and `books`;
- a weight from 0 to 100.

**Desktop (≥ 1180 px):** each page shows up to **3** promoted cards in a sticky right sidebar.

**Narrower screens:** one card is placed inline in the list, labelled **Promoted**.

**Counts:**

- A view is counted once per card, when it is actually visible (IntersectionObserver).
- Clicks are sent with `sendBeacon`.
- Both are shown in /admin with the CTR.
- Counts are aggregate only, not tied to users.

### API

```
GET  /api/promotions?placement=discover|feed|venues|books
POST /api/promotions/seen {ids}         POST /api/promotions/:id/click
GET|POST /api/admin/promotions          PATCH|DELETE /api/admin/promotions/:id
GET  /api/admin/promotions/candidates?type=event|post&q=
```

## Other endpoints

```
GET  /api/stt/config                    → { allowed, signedIn, secondsLeft, captionSecondsLeft, ... }
POST /api/stt?mode=dictate|caption&lang  (audio body, X-Audio-Ms header; signed-in user or room participant)
POST /api/voice/date {text, tzOffset}    → { start, end, hasTime }   (chrono-node)
GET  /api/covers/config   POST /api/covers/generate {title, description, category}
POST /api/covers/pick {token, title}     → { url, materialId }
/api/books/*                              (scripture; /api/bible/* kept as an alias)
```
