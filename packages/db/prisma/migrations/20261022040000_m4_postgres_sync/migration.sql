ALTER TYPE "DataSourceType" ADD VALUE 'POSTGRES';

ALTER TABLE "data_sources"
  ALTER COLUMN "format" DROP NOT NULL,
  ALTER COLUMN "staging_path" DROP NOT NULL,
  ALTER COLUMN "original_name" DROP NOT NULL,
  ALTER COLUMN "size_bytes" DROP NOT NULL,
  ALTER COLUMN "row_count" DROP NOT NULL,
  ALTER COLUMN "schema_json" DROP NOT NULL,
  ADD COLUMN "encrypted_config" TEXT,
  ADD COLUMN "sync_policy_json" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "last_tested_at" TIMESTAMP(3),
  ADD COLUMN "last_sync_at" TIMESTAMP(3),
  ADD COLUMN "error_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_error" TEXT,
  ADD COLUMN "created_by_id" UUID;

ALTER TABLE "search_indexes" ADD COLUMN "source_dataset_id" UUID;
ALTER TABLE "ingestion_runs" ALTER COLUMN "generation_id" DROP NOT NULL;
ALTER TABLE "ingestion_runs" ALTER COLUMN "triggered_by_id" DROP NOT NULL;

CREATE TABLE "source_datasets" (
  "id" UUID NOT NULL,
  "data_source_id" UUID NOT NULL,
  "schema_name" TEXT NOT NULL,
  "table_name" TEXT NOT NULL,
  "primary_key_field" TEXT NOT NULL,
  "updated_at_field" TEXT NOT NULL,
  "deleted_at_field" TEXT,
  "field_allowlist_json" JSONB NOT NULL,
  "column_types_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "source_datasets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sync_cursors" (
  "id" UUID NOT NULL,
  "search_index_id" UUID NOT NULL,
  "value_json" JSONB NOT NULL DEFAULT '{}',
  "last_success_at" TIMESTAMP(3),
  "last_reconcile_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sync_cursors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scheduled_syncs" (
  "id" UUID NOT NULL,
  "search_index_id" UUID NOT NULL,
  "interval_minutes" INTEGER NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "next_run_at" TIMESTAMP(3) NOT NULL,
  "last_queued_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "scheduled_syncs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reconciliation_previews" (
  "id" UUID NOT NULL,
  "search_index_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "missing_ids_json" JSONB NOT NULL DEFAULT '[]',
  "source_count" INTEGER NOT NULL DEFAULT 0,
  "indexed_count" INTEGER NOT NULL DEFAULT 0,
  "complete" BOOLEAN NOT NULL DEFAULT false,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "executed_at" TIMESTAMP(3),
  "failure_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reconciliation_previews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "source_datasets_data_source_id_schema_name_table_name_key" ON "source_datasets"("data_source_id", "schema_name", "table_name");
CREATE INDEX "source_datasets_data_source_id_idx" ON "source_datasets"("data_source_id");
CREATE INDEX "search_indexes_source_dataset_id_idx" ON "search_indexes"("source_dataset_id");
CREATE UNIQUE INDEX "sync_cursors_search_index_id_key" ON "sync_cursors"("search_index_id");
CREATE UNIQUE INDEX "scheduled_syncs_search_index_id_key" ON "scheduled_syncs"("search_index_id");
CREATE INDEX "scheduled_syncs_enabled_next_run_at_idx" ON "scheduled_syncs"("enabled", "next_run_at");
CREATE UNIQUE INDEX "reconciliation_previews_token_hash_key" ON "reconciliation_previews"("token_hash");
CREATE INDEX "reconciliation_previews_search_index_id_created_at_idx" ON "reconciliation_previews"("search_index_id", "created_at" DESC);

ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "search_indexes" ADD CONSTRAINT "search_indexes_source_dataset_id_fkey" FOREIGN KEY ("source_dataset_id") REFERENCES "source_datasets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "source_datasets" ADD CONSTRAINT "source_datasets_data_source_id_fkey" FOREIGN KEY ("data_source_id") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_search_index_id_fkey" FOREIGN KEY ("search_index_id") REFERENCES "search_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scheduled_syncs" ADD CONSTRAINT "scheduled_syncs_search_index_id_fkey" FOREIGN KEY ("search_index_id") REFERENCES "search_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reconciliation_previews" ADD CONSTRAINT "reconciliation_previews_search_index_id_fkey" FOREIGN KEY ("search_index_id") REFERENCES "search_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
