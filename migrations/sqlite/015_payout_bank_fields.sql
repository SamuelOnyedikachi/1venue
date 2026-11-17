-- SQLite twin of src/features/commerce/migrations/20261123090000_payout_bank_fields.sql
ALTER TABLE payout_requests ADD COLUMN bank_name TEXT;
ALTER TABLE payout_requests ADD COLUMN account_number TEXT;
ALTER TABLE payout_requests ADD COLUMN account_name TEXT;
ALTER TABLE payout_requests ADD COLUMN bank_parse TEXT;
