DROP TRIGGER IF EXISTS promotions_placements_insert;
DROP TRIGGER IF EXISTS promotions_placements_update;

CREATE TRIGGER promotions_placements_insert BEFORE INSERT ON promotions
WHEN EXISTS(SELECT 1 FROM json_each(NEW.placements) WHERE value NOT IN ('discover','feed','venues','books','profile')) BEGIN
 SELECT RAISE(ABORT,'CHECK constraint failed: placements');
END;

CREATE TRIGGER promotions_placements_update BEFORE UPDATE ON promotions
WHEN EXISTS(SELECT 1 FROM json_each(NEW.placements) WHERE value NOT IN ('discover','feed','venues','books','profile')) BEGIN
 SELECT RAISE(ABORT,'CHECK constraint failed: placements');
END;
