\set ON_ERROR_STOP on

DROP SCHEMA IF EXISTS m7_projection_test CASCADE;
CREATE SCHEMA m7_projection_test AUTHORIZATION connector_admin;

CREATE TABLE m7_projection_test.products (
  id text PRIMARY KEY,
  title text NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE m7_projection_test.inventory (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES m7_projection_test.products(id) ON DELETE CASCADE,
  quantity integer NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE m7_projection_test.tags (
  id text PRIMARY KEY,
  name text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE m7_projection_test.product_tags (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES m7_projection_test.products(id) ON DELETE CASCADE,
  tag_id text NOT NULL REFERENCES m7_projection_test.tags(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL,
  UNIQUE (product_id, tag_id)
);

CREATE TABLE m7_projection_test.controls (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  slow_final_page boolean NOT NULL DEFAULT false
);

INSERT INTO m7_projection_test.products (id, title, updated_at, deleted_at) VALUES
  ('p-001', 'M7 Keyboard', '2026-10-23T08:00:00Z', NULL),
  ('p-002', 'M7 Mouse', '2026-10-23T08:00:01Z', NULL),
  ('p-003', 'M7 Monitor', '2026-10-23T08:00:02Z', NULL),
  ('p-004', 'M7 Speaker', '2026-10-23T08:00:03Z', NULL);

INSERT INTO m7_projection_test.inventory (id, product_id, quantity, updated_at) VALUES
  ('inv-001', 'p-001', 3, '2026-10-23T08:01:00Z'),
  ('inv-002', 'p-002', 7, '2026-10-23T08:01:01Z'),
  ('inv-003', 'p-003', 2, '2026-10-23T08:01:02Z'),
  ('inv-004', 'p-004', 5, '2026-10-23T08:01:03Z');

INSERT INTO m7_projection_test.tags (id, name, updated_at) VALUES
  ('tag-blue', 'Blue', '2026-10-23T08:02:00Z'),
  ('tag-featured', 'Featured', '2026-10-23T08:02:01Z'),
  ('tag-office', 'Office', '2026-10-23T08:02:02Z');

INSERT INTO m7_projection_test.product_tags (id, product_id, tag_id, updated_at) VALUES
  ('pt-001', 'p-001', 'tag-blue', '2026-10-23T08:03:00Z'),
  ('pt-002', 'p-001', 'tag-featured', '2026-10-23T08:03:01Z'),
  ('pt-003', 'p-002', 'tag-office', '2026-10-23T08:03:02Z'),
  ('pt-004', 'p-003', 'tag-featured', '2026-10-23T08:03:03Z'),
  ('pt-005', 'p-004', 'tag-office', '2026-10-23T08:03:04Z');

INSERT INTO m7_projection_test.controls (singleton, slow_final_page)
VALUES (true, false);

CREATE FUNCTION m7_projection_test.allow_product(row_id text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, m7_projection_test
AS $$
BEGIN
  IF row_id = 'p-004'
     AND EXISTS (
       SELECT 1
       FROM m7_projection_test.controls
       WHERE singleton AND slow_final_page
     ) THEN
    PERFORM pg_sleep(1);
  END IF;
  RETURN true;
END;
$$;

ALTER TABLE m7_projection_test.products ENABLE ROW LEVEL SECURITY;
CREATE POLICY connector_reader_products
  ON m7_projection_test.products
  FOR SELECT
  TO connector_reader
  USING (m7_projection_test.allow_product(id));

REVOKE ALL ON FUNCTION m7_projection_test.allow_product(text) FROM PUBLIC;
GRANT USAGE ON SCHEMA m7_projection_test TO connector_reader;
GRANT SELECT ON
  m7_projection_test.products,
  m7_projection_test.inventory,
  m7_projection_test.tags,
  m7_projection_test.product_tags
TO connector_reader;
GRANT EXECUTE ON FUNCTION m7_projection_test.allow_product(text) TO connector_reader;

