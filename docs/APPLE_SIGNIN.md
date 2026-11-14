# Continue with Apple (Sign in with Apple for the web)

The "Continue with Apple" button shows on sign-in and sign-up once four environment values are
set. Until then it stays hidden and nothing else changes.

> **You need a paid Apple Developer Program membership** (US$99 a year,
> <https://developer.apple.com/programs/>). Free Apple accounts cannot create Services IDs or
> Sign in with Apple keys. Enrolment as an organisation needs a D-U-N-S number and can take a few
> days. An individual enrolment is faster.

## What you will end up with

| Coolify variable | Where it comes from | Example |
| --- | --- | --- |
| `APPLE_TEAM_ID` | Membership details | `A1B2C3D4E5` |
| `APPLE_CLIENT_ID` | the **Services ID** identifier (step 2) | `live.1venue.signin` |
| `APPLE_KEY_ID` | the key's Key ID (step 4) | `XYZ987WVU6` |
| `APPLE_PRIVATE_KEY` | contents of the downloaded `AuthKey_XYZ987WVU6.p8` | `-----BEGIN PRIVATE KEY-----\nMIGT...\n-----END PRIVATE KEY-----` |

## Steps (developer.apple.com → Account → Certificates, Identifiers & Profiles)

### 1. App ID (the "primary" ID that owns Sign in with Apple)

1. **Identifiers → +** → **App IDs** → Continue → type **App** → Continue.
2. Description: `1venue`. Bundle ID: **Explicit**, `live.1venue.app`
   (use the same one later for the iOS app).
3. Under **Capabilities**, tick **Sign in with Apple** (leave it as "Enable as a primary App ID").
4. Continue → Register.

### 2. Services ID (this is what the website uses; it becomes `APPLE_CLIENT_ID`)

1. **Identifiers → +** → **Services IDs** → Continue.
2. Description: `1venue web sign-in` (users see this name on Apple's consent screen).
   Identifier: `live.1venue.signin`. It must differ from the App ID.
3. Register, then open the new Services ID, tick **Sign in with Apple** → **Configure**:
   * **Primary App ID**: the `live.1venue.app` App ID from step 1.
   * **Domains and Subdomains**: `1venue.live`
   * **Return URLs**: `https://1venue.live/auth/apple/callback`
     (exactly this: https, no trailing slash. Apple does not accept `localhost` or IP addresses.)
   * Next → Done → Continue → **Save**.
4. For staging, add `mav.1venue.live` and `https://mav.1venue.live/auth/apple/callback` to the
   same lists (you can have several).

### 3. Team ID

Top right of the developer site, or **Membership details** → **Team ID** (10 characters).
That is `APPLE_TEAM_ID`.

### 4. Key (signs the client secret; becomes `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY`)

1. **Keys → +**. Name: `1venue Sign in with Apple`.
2. Tick **Sign in with Apple** → **Configure** → Primary App ID `live.1venue.app` → Save.
3. Continue → Register → **Download**. You get `AuthKey_<KEYID>.p8` **once only**; keep it safe
   (a password manager is ideal). If you lose it, revoke the key and make a new one.
4. The **Key ID** shown on that page is `APPLE_KEY_ID`.

### 5. Private email relay (so "Hide My Email" users get your emails)

Users can hide their address; Apple then gives 1venue an address like
`abc123@privaterelay.appleid.com`. Apple only forwards mail to it from senders you register:

1. **Services → Sign in with Apple for Email Communication → Configure** (`+`).
2. Add the domain `1venue.live` and the address you send from (your `MAIL_FROM`, e.g.
   `no-reply@1venue.live`).
3. Apple checks SPF for the domain, so your SPF record must include your mail host
   (and DKIM signing is strongly recommended). Without this, verification, reset and
   account-deletion codes never reach relay users.

### 6. Coolify

In the 1venue app → **Environment Variables** (Developer view), add:

```
APPLE_CLIENT_ID=live.1venue.signin
APPLE_TEAM_ID=A1B2C3D4E5
APPLE_KEY_ID=XYZ987WVU6
APPLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg...\n-----END PRIVATE KEY-----
APPLE_ALLOW_SIGNUP=true
```

`APPLE_PRIVATE_KEY` can be the whole `.p8` file pasted as a multi-line value, or one line with
`\n` where the line breaks were, or just the base64 middle part. All three work. Mark it as a
secret / not shown in build logs. Redeploy. No database or firewall changes are needed.

`PUBLIC_URL` must be `https://1venue.live` (the return URL is built from it).

### 7. Test

Open `https://1venue.live/login` in a private window → **Continue with Apple** → sign in → you
land back on 1venue signed in. In **Settings → Account** the Apple row shows "Connected".
If something is wrong you are sent to `/login?error=apple-…` and the app log shows
`[apple] sign-in failed: <reason>`:

| Log reason | Fix |
| --- | --- |
| `Apple 400: invalid_client` | `APPLE_CLIENT_ID` is the App ID instead of the Services ID, or Team ID / Key ID / key don't match |
| `Apple 400: invalid_grant` | Return URL in the Services ID doesn't exactly match `https://1venue.live/auth/apple/callback`, or the code was reused |
| `apple-expired` error | the sign-in took longer than 10 minutes, or the browser blocked the `SameSite=None` cookie (only possible on plain http) |

## How it works (for developers)

* `GET /auth/apple/start` sets a signed 10-minute flow cookie (`state`, `nonce`, `next`;
  `SameSite=None; Secure`) and redirects to `https://appleid.apple.com/auth/authorize` with
  `response_type=code`, `response_mode=form_post`, `scope=name email`.
* Apple POSTs `code`, `state` (and `user`, with the name, on first sign-in only) to
  `POST /auth/apple/callback`. No CSRF token is possible on that cross-site POST; the posted
  `state` must equal the cookie's, and the ID token's `nonce` must equal the cookie's nonce.
* The server exchanges the code at `https://appleid.apple.com/auth/token` with a client secret
  that is an ES256 JWT (`iss` team, `sub` Services ID, `aud` `https://appleid.apple.com`,
  `kid` key ID, 5-minute lifetime) signed with the `.p8` key.
* The ID token is verified with Apple's JWKS (`https://appleid.apple.com/auth/keys`): RS256
  signature, `iss`, `aud` (Services ID), `exp`, `nonce`.
* Accounts link the same way as Google: an existing Apple link, else the same verified email,
  else a new account with an auto-generated username (`APPLE_ALLOW_SIGNUP=false` turns that off).
* Code: `src/features/auth/apple.js` (protocol), `src/features/auth/http.js` (routes),
  tests in `test/apple.test.js` (a mock Apple server).

## iOS app later

When the iOS app ships, use native Sign in with Apple there (App ID `live.1venue.app`), and
App Store review also requires in-app account deletion, which 1venue already has
(Settings → Danger zone → Delete account).
