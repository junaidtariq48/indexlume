CREATE ROLE connector_reader LOGIN PASSWORD 'connector-read-only';
ALTER ROLE connector_reader SET default_transaction_read_only = on;

CREATE TABLE public.products (
  id text PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  price double precision NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);

INSERT INTO public.products (id, name, category, price, updated_at) VALUES
  ('pg-001', 'PostgreSQL Keyboard', 'keyboards', 129.00, '2026-10-22T10:00:00Z'),
  ('pg-002', 'PostgreSQL Mouse', 'mice', 69.00, '2026-10-22T10:00:00Z'),
  ('pg-003', 'PostgreSQL Monitor', 'monitors', 399.00, '2026-10-22T10:01:00Z');

GRANT CONNECT ON DATABASE connector_fixture TO connector_reader;
GRANT USAGE ON SCHEMA public TO connector_reader;
GRANT SELECT ON public.products TO connector_reader;
