# Credit wallets and Paystack: first increment

The user requested implementation of an initial part of the agreed billing update and explicitly deferred venues. This increment delivers spending wallets and credit purchases, the prerequisite for meeting billing and paid admission. Work continues on the user's `marvel` branch. No production push or deployment is authorized.

## Agreed product rules

- Paystack replaces Monnify. NGN 500 buys one credit.
- Offer 10 / 30 / 60 / 120 credits (NGN 5,000 / 15,000 / 30,000 / 60,000) and custom whole-credit purchases at the same rate. No discounts and no expiry.
- Customers bear processing fees, disclosed at checkout. Use Paystack's dashboard preference to pass fees to customers, without applying another markup in the application.
- Future meeting billing: one credit per minute, proportional elapsed time (90 seconds = 1.5 credits). A host needs 30 credits to start, receives a warning at 10 minutes remaining, and the room ends when the spending wallet runs out. Billing begins when the host opens a room. One hosted room per account at a time.
- Future room types: host-funded or paid-entry. Both deduct running costs from the host's spending wallet.
- Paid-entry participants must sign in. Waiting is free; host acceptance atomically charges and admits. Insufficient funds keep the person waiting; after topping up the host must accept again.
- A single admission payment covers rejoining and extensions. Every first-time admission pays the full host-set entry price, even late or during an extension.
- Split admission credits: 80% host pending earnings, 20% platform. Release earnings only after the meeting ends and refunds settle. Available earnings may later be transferred to spending credits.
- Proportional refunds for early room termination use the remaining promised time at each participant's admission. Reverse both shares proportionally. Voluntary departure gives no automatic refund.
- Hosts cannot remove paying admitted participants, but can restrict microphone, camera, screen sharing, and chat.
- Paid-entry meetings require a stated duration. Hosts may extend and continue funding the room.
- Venue funding and administration rules are expressly deferred.

## Scope and decisions for this increment

Deliver `/wallet`, authenticated wallet/quote/checkout/status/history APIs, Paystack initialization and server verification, and an authenticated raw-body webhook endpoint. Do not switch on meeting charges, admissions, earnings settlement, subscriptions, or cash withdrawals yet. Preserve these agreed rules for the subsequent increment.

Use the existing automatic feature discovery in `src/features/wallet`, native fetch, crypto, and the shared `db.q`/`db.tx` interface. Add equivalent PostgreSQL feature migrations and SQLite migrations. No third-party payment SDK is needed for hosted checkout.

Represent credits internally as integer units (60,000 units per credit) so future per-second billing and fractional splits can be exact. Money is integer kobo. Every successful purchase updates the balance and inserts an immutable purchase ledger record in the same transaction. Unique payment references, provider transaction IDs, and one ledger record per payment prevent double crediting across webhook retries and concurrent verification. Balances must stay within JavaScript's safe integer range.

Store purchase expectations before calling Paystack: user, account email at purchase, credit amount, price in kobo, reference, and provider mode. Never accept a client-supplied money amount or credit balance. Only an authenticated owner can initialize or recheck a purchase. Wallet history is private and paginated. Checkout uses an explicit user action and an allowlisted Paystack authorization URL.

Use server-side verification of reference, success status, requested amount, currency, customer, mode, and purchase metadata. Confirm actual paid amount minus the reported fees covers the credit price. When provider data does not match, do not mint credits. Pending payments remain recoverable after reload/restart; a transient API failure does not imply payment failure. No credits are issued merely for visiting the callback URL.

Use `/payments/paystack/webhook` outside the generic API IP limit. Verify raw bytes before parsing. Support the current timestamped `Paystack-Signature` HMAC-SHA512 format using a `whsec_` signing secret and a 300-second clock tolerance; require that format when configured. Otherwise support the legacy `x-paystack-signature` with the API secret. A valid notification triggers the same authoritative verification/settlement path as the owner recheck. Return success only after durable processing; temporary provider/DB errors return a retryable response. Unknown references and unrelated events are harmless acknowledgements.

Purchases require a configured Paystack key, a configured public callback URL, and explicit confirmation that the merchant enabled customer-paid fees in Paystack. No fake purchases or automatic local credit grant. Local integration tests use a mock gateway; the app can use real Paystack test credentials when supplied. Production requests use the official API; test-only loopback overrides support isolated integration tests.

Account deletion is blocked while a credit balance or unresolved payment exists, so funds cannot silently disappear. This is a protective implementation decision for the first increment; support/refund resolution is a prerequisite for closing a funded account. Production rejects sandbox checkout. Test balances must live in a separate database.

## Verification and delivery

Test real SQLite and, when available, disposable PostgreSQL: sign-in protection, custom/bundle amounts, rejection of invalid amounts, requested price integrity, failed/pending/mismatched payments, concurrent callback/webhook processing, cross-account access, duplicate provider IDs, raw signature validation/downgrade rejection, interrupted initialization, persisted pending history, and ledger/balance consistency. Exercise the wallet page on desktop and narrow mobile widths. Run the existing suite and an independent code review before committing. Do not claim live Paystack verification without supplied credentials.

Official references checked on 2026-11-16:
- https://paystack.com/docs/payments/accept-payments/
- https://paystack.com/docs/api/transaction/
- https://paystack.com/docs/payments/webhooks/
- https://support.paystack.com/en/articles/2130306
