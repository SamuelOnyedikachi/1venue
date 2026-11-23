-- Allow platform-owned AI cover-library files (distinct from user-uploaded covers).
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_purpose_check;
ALTER TABLE files ADD CONSTRAINT files_purpose_check
  CHECK (purpose IN ('attachment','avatar','cover','post','timeline','transcript','content','chat','voice','whiteboard','sound','tts','cover-library','other'));
