# Credit wallet implementation plan

> Implement inline using the executing-plans and test-driven-development workflows. User authorized the first implementation increment; venues remain deferred.

**Goal:** Purchase the agreed non-expiring credits through Paystack and view a reliable, private spending wallet.
**Spec:** `docs/superpowers/specs/2026-11-16-credit-wallet-design.md`.
**Architecture:** Automatic wallet feature, shared SQL interface, equivalent PostgreSQL/SQLite migrations, hosted Paystack checkout, atomic payment/ledger settlement, vanilla JS wallet page.

## Tasks

- [x] 1. Write failing pricing/signature and wallet integration tests. Record the existing baseline.
- [x] 2. Add wallet, purchase, and ledger schema; integer credit units and atomic exactly-once settlement. Test both supported databases where available.
- [x] 3. Add Paystack configuration, API client, verified purchase flow, authenticated private endpoints, and raw signed webhook handler. Test pending/error/retry paths and concurrency.
- [ ] 4. Add `/wallet` page, bundle/custom choice, price disclosure, Paystack redirect/return verification, balance/history and purchase rechecks. Link from account menu, settings and command bar. Verify desktop and mobile UI.
- [x] 5. Document merchant fee/signature setup, test-mode procedure and remaining meeting-billing scope. Run full suites, review independently, fix important findings, and commit on `marvel`.

## Review focus

- A return URL or forged/replayed webhook cannot create credits.
- Paystack charges and credit prices are not confused when fees are passed to customers.
- Two concurrent settlement attempts create one balance increment and one ledger entry.
- Pending payments remain visible and recheckable after network failures or reloads.
- New monetary records behave safely around account deletion and absent gateway configuration.

## Progress

Backend and UI implementation complete. Independent review identified seed-cleanup deletion protection and purchase pagination; both are fixed with regression coverage. Verification passed: final SQLite suite 133 passed / 5 skipped / 0 failed; PostgreSQL suite 132 passed / 6 skipped / 0 failed. PostgreSQL seed tests also passed after the final cleanup change (3/3). Syntax checks and git diff --check passed. A transient smoke startup failure passed on isolated rerun and the subsequent full SQLite run. Local commit prepared on marvel; no push or deployment. Browser preview could not run because this session has no available browser; desktop/mobile visual QA remains outstanding. Automated gateway tests use a mock provider; merchant sandbox verification requires real test credentials.

Task 4 implementation is delivered; its browser visual verification remains unchecked because the available browser tool reported no browser. This does not replace merchant sandbox or visual acceptance checks.
