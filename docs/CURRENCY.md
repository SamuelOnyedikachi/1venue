# Currency, processing fee and auto top-up

## Processing fee

Every paid checkout adds a processing fee on top of the price: credit packs, plan subscriptions and
renewals, short links, auto top-ups, tickets, donations and promotions.

```
PROCESSING_FEE_PERCENT=3        # 0–20, decimals allowed (e.g. 2.5). 0 turns it off.
```

- Maths is in integer minor units (kobo): `fee = round_half_up(subtotal × percent / 100)`, `total = subtotal + fee`.
  `src/lib/money.js` `withFee()` on the server, mirrored in `public/js/money.js` for display.
- The gateway is asked for the **total**. Each payment row records `price_kobo` (total charged),
  `subtotal_kobo`, `processing_fee_kobo` and `fee_percent`; admin payment lists show the split.
- Checkout screens show Subtotal / Processing fee (3%) / Total before redirecting to hosted checkout.
- Credits bought are always the subtotal's worth; the fee buys nothing. Host ticket/donation earnings and
  the platform split use the subtotal.
- Turn **off** Paystack's *Pass fees to customers* when this fee is on (see docs/PAYMENTS.md).

## Currencies

People choose a billing address and a preferred currency in **Settings → Billing address & currency**
(`GET/PUT /api/me/billing-profile`). Supported: NGN (default), USD, GBP, EUR, GHS, KES, ZAR, CAD.

```
CURRENCY_BASE=NGN
FX_RATES={"USD":0.00062,"GBP":0.00049,"EUR":0.00057,"GHS":0.0095,"KES":0.08,"ZAR":0.0112,"CAD":0.00087}
```

- Prices are stored and **charged in the base currency (NGN)**; the gateway account and the payment tables
  are NGN. Other currencies are display prices: pricing, upgrade, wallet, short links and checkout show the
  person's currency with `Intl.NumberFormat`, and say "Charged in NGN as …" when it differs.
- Each payment records what the person saw: `display_currency`, `display_total_minor`, `fx_rate`.
- Rates are units of each currency per 1 NGN. Order of precedence: rates saved in **/admin → Currency and
  exchange rates** (app_settings `fx`), then `FX_RATES`, then built-in **placeholder** rates. Placeholders are
  flagged in /admin and in Settings for admins; replace them before showing foreign prices to customers.
- `GET /api/money` gives the client the base, rates, fee percent and the person's currency.

## Auto top-up (accounts without a paid plan)

Settings → Auto top-up: on/off, "when my balance falls below" (credits), pack size, monthly cap, saved card and
the last run. Subscribers see a note that their plan covers meeting time.

- **Saving a card:** "Add card" buys the chosen pack once through hosted checkout (card channel). On success
  the gateway's reusable `authorization_code` plus brand, last 4 and expiry are kept. 1venue never sees or
  stores card numbers or CVV.
- **Trigger:** after every credit debit, if the balance is below the threshold, the server charges the saved
  authorization (`/transaction/charge_authorization`) for pack + processing fee and records it as a credit
  purchase with `source='auto_topup'`.
- **Safety:** one run per account at a time (DB claim on `auto_topups.running_ref`), unique payment references,
  and the monthly cap counts paid, pending and review top-ups in the calendar month (UTC).
- **Failures:** retried after `AUTO_TOPUP_RETRY_MS`; after `AUTO_TOPUP_MAX_FAILURES` failures in a row auto
  top-up turns itself off. The owner is emailed on each top-up, failure, cap and turn-off.

```
AUTO_TOPUP=true                 # false disables the trigger
AUTO_TOPUP_MAX_FAILURES=3
AUTO_TOPUP_RETRY_MS=3600000
```
