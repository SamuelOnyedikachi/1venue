-- Host tools round: payout bank details as separate fields. Additive only: bank_details (the original free
-- text) is kept as it was; older rows are parsed best-effort by the app (bank_parse = 'parsed' | 'partial').
ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS bank_name TEXT;
ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS account_number TEXT;
ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS account_name TEXT;
ALTER TABLE payout_requests ADD COLUMN IF NOT EXISTS bank_parse TEXT;
