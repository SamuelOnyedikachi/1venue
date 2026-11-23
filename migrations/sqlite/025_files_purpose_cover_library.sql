DROP TRIGGER IF EXISTS check_files_insert;
CREATE TRIGGER IF NOT EXISTS check_files_insert BEFORE INSERT ON files
WHEN NOT (regexp('^[A-Za-z0-9_-]{16,64}$',NEW.id) AND NEW.driver IN ('local','s3') AND NEW.size_bytes>=0 AND NEW.purpose IN ('attachment','avatar','cover','post','timeline','transcript','content','chat','voice','whiteboard','sound','tts','cover-library','other')) BEGIN
 SELECT RAISE(ABORT, 'CHECK constraint failed: files');
END;

DROP TRIGGER IF EXISTS check_files_update;
CREATE TRIGGER IF NOT EXISTS check_files_update BEFORE UPDATE ON files
WHEN NOT (regexp('^[A-Za-z0-9_-]{16,64}$',NEW.id) AND NEW.driver IN ('local','s3') AND NEW.size_bytes>=0 AND NEW.purpose IN ('attachment','avatar','cover','post','timeline','transcript','content','chat','voice','whiteboard','sound','tts','cover-library','other')) BEGIN
 SELECT RAISE(ABORT, 'CHECK constraint failed: files');
END;
