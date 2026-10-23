ALTER TYPE "IndexGenerationState" ADD VALUE 'SUPERSEDED';

CREATE TYPE "DataSourceType" AS ENUM ('UPLOAD');
CREATE TYPE "DataSourceState" AS ENUM ('READY', 'ERROR');
CREATE TYPE "UploadFormat" AS ENUM ('CSV', 'JSONL');
CREATE TYPE "IngestionRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL_FAILED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED');

CREATE TABLE "data_sources" (
  "id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "type" "DataSourceType" NOT NULL DEFAULT 'UPLOAD',
  "state" "DataSourceState" NOT NULL DEFAULT 'READY',
  "format" "UploadFormat" NOT NULL,
  "staging_path" TEXT NOT NULL,
  "original_name" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "row_count" INTEGER NOT NULL,
  "schema_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "data_sources_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "search_indexes" ADD COLUMN "source_id" UUID;

CREATE TABLE "ingestion_runs" (
  "id" UUID NOT NULL,
  "search_index_id" UUID NOT NULL,
  "generation_id" UUID NOT NULL,
  "source_id" UUID NOT NULL,
  "triggered_by_id" UUID NOT NULL,
  "trigger" TEXT NOT NULL,
  "status" "IngestionRunStatus" NOT NULL DEFAULT 'QUEUED',
  "scanned" INTEGER NOT NULL DEFAULT 0,
  "succeeded" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "deleted" INTEGER NOT NULL DEFAULT 0,
  "cursor_json" JSONB NOT NULL DEFAULT '{}',
  "error_summary" TEXT,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ingestion_errors" (
  "id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "source_key" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "sanitized_message" TEXT NOT NULL,
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "payload_fingerprint" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ingestion_errors_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "data_sources_project_id_created_at_idx" ON "data_sources"("project_id", "created_at" DESC);
CREATE INDEX "search_indexes_source_id_idx" ON "search_indexes"("source_id");
CREATE INDEX "ingestion_runs_search_index_id_created_at_idx" ON "ingestion_runs"("search_index_id", "created_at" DESC);
CREATE INDEX "ingestion_runs_status_created_at_idx" ON "ingestion_runs"("status", "created_at");
CREATE INDEX "ingestion_errors_run_id_created_at_idx" ON "ingestion_errors"("run_id", "created_at");

ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "search_indexes" ADD CONSTRAINT "search_indexes_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "data_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_search_index_id_fkey" FOREIGN KEY ("search_index_id") REFERENCES "search_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "index_generations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "data_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ingestion_errors" ADD CONSTRAINT "ingestion_errors_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "ingestion_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
