-- Hierarchy is organizational only. Memberships remain independently scoped.
ALTER TABLE customers ADD COLUMN parent_id INTEGER REFERENCES customers(id) ON DELETE RESTRICT;
-- statement-breakpoint
CREATE INDEX idx_customers_parent ON customers(parent_id);
-- statement-breakpoint
-- AFTER INSERT also checks the actual AUTOINCREMENT id when none was supplied.
CREATE TRIGGER customers_parent_insert
AFTER INSERT ON customers
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'customer_hierarchy_cycle')
  WHERE EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT NEW.parent_id
      UNION
      SELECT c.parent_id FROM customers c JOIN ancestors a ON c.id = a.id
       WHERE c.parent_id IS NOT NULL
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  );
END;
-- statement-breakpoint
CREATE TRIGGER customers_parent_update
BEFORE UPDATE OF parent_id, id ON customers
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'customer_hierarchy_cycle')
  WHERE EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT NEW.parent_id
      UNION
      SELECT c.parent_id FROM customers c JOIN ancestors a ON c.id = a.id
       WHERE c.parent_id IS NOT NULL
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  );
END;
