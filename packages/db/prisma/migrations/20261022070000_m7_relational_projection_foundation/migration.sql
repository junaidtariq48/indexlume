CREATE TYPE "ProjectionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'PAUSED', 'INVALID');
CREATE TYPE "ProjectionVersionStatus" AS ENUM ('DRAFT', 'VALIDATED', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "ProjectionGenerationStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY_TO_PROMOTE', 'PROMOTING', 'ACTIVE', 'FAILED', 'CANCELLED', 'SUPERSEDED');
CREATE TYPE "ProjectionWorkStatus" AS ENUM ('PENDING', 'LEASED', 'COMPLETED', 'FAILED');
CREATE TYPE "ProjectionReconcileStatus" AS ENUM ('QUEUED', 'SCANNING', 'COMPLETE', 'AWAITING_CONFIRMATION', 'EXECUTING', 'EXECUTED', 'INVALID');
CREATE TYPE "ProjectionCandidateState" AS ENUM ('PROPOSED', 'CONFIRMED', 'EXECUTED', 'INVALID');

CREATE TABLE "source_projections" (
  "id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "source_id" UUID NOT NULL,
  "search_index_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "status" "ProjectionStatus" NOT NULL DEFAULT 'DRAFT',
  "active_version_id" UUID,
  "draft_version_id" UUID,
  "created_by_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "source_projections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "source_projection_versions" (
  "id" UUID NOT NULL,
  "projection_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "ProjectionVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "config_json" JSONB NOT NULL,
  "config_hash" TEXT NOT NULL,
  "schema_fingerprint" TEXT NOT NULL,
  "validation_json" JSONB NOT NULL DEFAULT '{}',
  "created_by_id" UUID NOT NULL,
  "validated_at" TIMESTAMP(3),
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "source_projection_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "projection_generations" (
  "id" UUID NOT NULL,
  "projection_id" UUID NOT NULL,
  "projection_version_id" UUID NOT NULL,
  "index_generation_id" UUID NOT NULL,
  "status" "ProjectionGenerationStatus" NOT NULL DEFAULT 'QUEUED',
  "fencing_token" BIGINT NOT NULL DEFAULT 0,
  "root_checkpoint_json" JSONB NOT NULL DEFAULT '{}',
  "counters_json" JSONB NOT NULL DEFAULT '{}',
  "manifest_hash" TEXT,
  "snapshot_watermarks_json" JSONB NOT NULL DEFAULT '{}',
  "reconciliation_complete" BOOLEAN NOT NULL DEFAULT false,
  "error_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "projection_generations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "relation_scan_cursors" (
  "id" UUID NOT NULL,
  "projection_id" UUID NOT NULL,
  "projection_version_id" UUID NOT NULL,
  "relation_id" TEXT NOT NULL,
  "cursor_time" TIMESTAMP(3),
  "cursor_tuple_json" JSONB NOT NULL DEFAULT '[]',
  "overlap_seconds" INTEGER NOT NULL DEFAULT 2,
  "checkpoint_version" BIGINT NOT NULL DEFAULT 0,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "relation_scan_cursors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "projection_change_events" (
  "id" UUID NOT NULL,
  "projection_id" UUID NOT NULL,
  "projection_version_id" UUID NOT NULL,
  "relation_id" TEXT NOT NULL,
  "relation_key_hmac" TEXT NOT NULL,
  "relation_key_ciphertext" TEXT NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "status" "ProjectionWorkStatus" NOT NULL DEFAULT 'PENDING',
  "occurred_at" TIMESTAMP(3),
  "processed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "projection_change_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "projection_dirty_roots" (
  "id" UUID NOT NULL,
  "projection_id" UUID NOT NULL,
  "projection_version_id" UUID NOT NULL,
  "root_key_hmac" TEXT NOT NULL,
  "root_key_ciphertext" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "ProjectionWorkStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "lease_until" TIMESTAMP(3),
  "fencing_token" BIGINT NOT NULL DEFAULT 0,
  "last_error_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "projection_dirty_roots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "projection_dependency_edges" (
  "id" UUID NOT NULL,
  "projection_id" UUID NOT NULL,
  "projection_version_id" UUID NOT NULL,
  "relation_id" TEXT NOT NULL,
  "related_key_hmac" TEXT NOT NULL,
  "root_key_hmac" TEXT NOT NULL,
  "root_key_ciphertext" TEXT NOT NULL,
  "first_seen_generation" INTEGER NOT NULL,
  "last_seen_generation" INTEGER NOT NULL,
  "removed_at" TIMESTAMP(3),
  "retain_until" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "projection_dependency_edges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "projection_document_states" (
  "id" UUID NOT NULL,
  "projection_id" UUID NOT NULL,
  "projection_version_id" UUID NOT NULL,
  "root_key_hmac" TEXT NOT NULL,
  "root_key_ciphertext" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "canonical_hash" TEXT NOT NULL,
  "active_generation_id" UUID,
  "terminal_state" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "projection_document_states_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "projection_reconcile_runs" (
  "id" UUID NOT NULL,
  "projection_id" UUID NOT NULL,
  "projection_version_id" UUID NOT NULL,
  "projection_generation_id" UUID,
  "active_index_generation_id" UUID NOT NULL,
  "status" "ProjectionReconcileStatus" NOT NULL DEFAULT 'QUEUED',
  "scan_started_at" TIMESTAMP(3),
  "scan_ended_at" TIMESTAMP(3),
  "complete" BOOLEAN NOT NULL DEFAULT false,
  "schema_fingerprint" TEXT NOT NULL,
  "manifest_digest" TEXT,
  "candidate_set_digest" TEXT,
  "expected_count" INTEGER NOT NULL DEFAULT 0,
  "root_count" INTEGER NOT NULL DEFAULT 0,
  "token_hash" TEXT,
  "expires_at" TIMESTAMP(3),
  "executed_at" TIMESTAMP(3),
  "invalid_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "projection_reconcile_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "projection_reconcile_candidates" (
  "id" UUID NOT NULL,
  "reconcile_run_id" UUID NOT NULL,
  "root_key_hmac" TEXT NOT NULL,
  "root_key_ciphertext" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "state" "ProjectionCandidateState" NOT NULL DEFAULT 'PROPOSED',
  "executed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "projection_reconcile_candidates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "projection_errors" (
  "id" UUID NOT NULL,
  "projection_id" UUID NOT NULL,
  "projection_version_id" UUID NOT NULL,
  "projection_generation_id" UUID,
  "code" TEXT NOT NULL,
  "sanitized_message" TEXT NOT NULL,
  "entity_hmac" TEXT,
  "retryable" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "projection_errors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "source_projections_search_index_id_key" ON "source_projections"("search_index_id");
CREATE UNIQUE INDEX "source_projections_active_version_id_key" ON "source_projections"("active_version_id");
CREATE UNIQUE INDEX "source_projections_draft_version_id_key" ON "source_projections"("draft_version_id");
CREATE UNIQUE INDEX "source_projections_project_id_name_key" ON "source_projections"("project_id", "name");
CREATE INDEX "source_projections_project_id_idx" ON "source_projections"("project_id");
CREATE INDEX "source_projections_source_id_idx" ON "source_projections"("source_id");
CREATE UNIQUE INDEX "source_projection_versions_projection_id_version_key" ON "source_projection_versions"("projection_id", "version");
CREATE INDEX "source_projection_versions_projection_id_config_hash_idx" ON "source_projection_versions"("projection_id", "config_hash");
CREATE UNIQUE INDEX "projection_generations_index_generation_id_key" ON "projection_generations"("index_generation_id");
CREATE INDEX "projection_generations_projection_id_created_at_idx" ON "projection_generations"("projection_id", "created_at" DESC);
CREATE INDEX "projection_generations_projection_version_id_idx" ON "projection_generations"("projection_version_id");
CREATE INDEX "projection_generations_status_created_at_idx" ON "projection_generations"("status", "created_at");
CREATE UNIQUE INDEX "relation_scan_cursors_projection_id_projection_version_id_relation_id_key" ON "relation_scan_cursors"("projection_id", "projection_version_id", "relation_id");
CREATE INDEX "relation_scan_cursors_projection_version_id_idx" ON "relation_scan_cursors"("projection_version_id");
CREATE UNIQUE INDEX "projection_change_events_dedupe_key_key" ON "projection_change_events"("dedupe_key");
CREATE INDEX "projection_change_events_projection_id_status_created_at_idx" ON "projection_change_events"("projection_id", "status", "created_at");
CREATE INDEX "projection_change_events_projection_version_relation_key_idx" ON "projection_change_events"("projection_version_id", "relation_id", "relation_key_hmac");
CREATE UNIQUE INDEX "projection_dirty_roots_projection_version_root_key" ON "projection_dirty_roots"("projection_id", "projection_version_id", "root_key_hmac");
CREATE INDEX "projection_dirty_roots_projection_status_priority_idx" ON "projection_dirty_roots"("projection_id", "status", "priority", "created_at");
CREATE UNIQUE INDEX "projection_dependency_edges_identity_key" ON "projection_dependency_edges"("projection_id", "projection_version_id", "relation_id", "related_key_hmac", "root_key_hmac");
CREATE INDEX "projection_dependency_edges_related_idx" ON "projection_dependency_edges"("projection_id", "projection_version_id", "relation_id", "related_key_hmac");
CREATE INDEX "projection_dependency_edges_projection_id_root_key_hmac_idx" ON "projection_dependency_edges"("projection_id", "root_key_hmac");
CREATE UNIQUE INDEX "projection_document_states_root_key" ON "projection_document_states"("projection_id", "projection_version_id", "root_key_hmac");
CREATE UNIQUE INDEX "projection_document_states_document_key" ON "projection_document_states"("projection_id", "projection_version_id", "document_id");
CREATE INDEX "projection_document_states_active_generation_id_idx" ON "projection_document_states"("active_generation_id");
CREATE UNIQUE INDEX "projection_reconcile_runs_token_hash_key" ON "projection_reconcile_runs"("token_hash");
CREATE INDEX "projection_reconcile_runs_projection_id_created_at_idx" ON "projection_reconcile_runs"("projection_id", "created_at" DESC);
CREATE INDEX "projection_reconcile_runs_projection_version_id_status_idx" ON "projection_reconcile_runs"("projection_version_id", "status");
CREATE INDEX "projection_reconcile_runs_active_index_generation_id_idx" ON "projection_reconcile_runs"("active_index_generation_id");
CREATE UNIQUE INDEX "projection_reconcile_candidates_reconcile_run_root_key" ON "projection_reconcile_candidates"("reconcile_run_id", "root_key_hmac");
CREATE INDEX "projection_reconcile_candidates_reconcile_run_id_state_idx" ON "projection_reconcile_candidates"("reconcile_run_id", "state");
CREATE INDEX "projection_errors_projection_id_created_at_idx" ON "projection_errors"("projection_id", "created_at" DESC);
CREATE INDEX "projection_errors_projection_generation_id_idx" ON "projection_errors"("projection_generation_id");

ALTER TABLE "source_projections" ADD CONSTRAINT "source_projections_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_projections" ADD CONSTRAINT "source_projections_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_projections" ADD CONSTRAINT "source_projections_search_index_id_fkey" FOREIGN KEY ("search_index_id") REFERENCES "search_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_projections" ADD CONSTRAINT "source_projections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_projection_versions" ADD CONSTRAINT "source_projection_versions_projection_id_fkey" FOREIGN KEY ("projection_id") REFERENCES "source_projections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_projection_versions" ADD CONSTRAINT "source_projection_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "source_projections" ADD CONSTRAINT "source_projections_active_version_id_fkey" FOREIGN KEY ("active_version_id") REFERENCES "source_projection_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "source_projections" ADD CONSTRAINT "source_projections_draft_version_id_fkey" FOREIGN KEY ("draft_version_id") REFERENCES "source_projection_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "projection_generations" ADD CONSTRAINT "projection_generations_projection_id_fkey" FOREIGN KEY ("projection_id") REFERENCES "source_projections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projection_generations" ADD CONSTRAINT "projection_generations_projection_version_id_fkey" FOREIGN KEY ("projection_version_id") REFERENCES "source_projection_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projection_generations" ADD CONSTRAINT "projection_generations_index_generation_id_fkey" FOREIGN KEY ("index_generation_id") REFERENCES "index_generations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "relation_scan_cursors" ADD CONSTRAINT "relation_scan_cursors_projection_id_fkey" FOREIGN KEY ("projection_id") REFERENCES "source_projections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "relation_scan_cursors" ADD CONSTRAINT "relation_scan_cursors_projection_version_id_fkey" FOREIGN KEY ("projection_version_id") REFERENCES "source_projection_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projection_change_events" ADD CONSTRAINT "projection_change_events_projection_id_fkey" FOREIGN KEY ("projection_id") REFERENCES "source_projections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projection_change_events" ADD CONSTRAINT "projection_change_events_projection_version_id_fkey" FOREIGN KEY ("projection_version_id") REFERENCES "source_projection_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projection_dirty_roots" ADD CONSTRAINT "projection_dirty_roots_projection_id_fkey" FOREIGN KEY ("projection_id") REFERENCES "source_projections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projection_dirty_roots" ADD CONSTRAINT "projection_dirty_roots_projection_version_id_fkey" FOREIGN KEY ("projection_version_id") REFERENCES "source_projection_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projection_dependency_edges" ADD CONSTRAINT "projection_dependency_edges_projection_id_fkey" FOREIGN KEY ("projection_id") REFERENCES "source_projections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projection_dependency_edges" ADD CONSTRAINT "projection_dependency_edges_projection_version_id_fkey" FOREIGN KEY ("projection_version_id") REFERENCES "source_projection_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projection_document_states" ADD CONSTRAINT "projection_document_states_projection_id_fkey" FOREIGN KEY ("projection_id") REFERENCES "source_projections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projection_document_states" ADD CONSTRAINT "projection_document_states_projection_version_id_fkey" FOREIGN KEY ("projection_version_id") REFERENCES "source_projection_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projection_document_states" ADD CONSTRAINT "projection_document_states_active_generation_id_fkey" FOREIGN KEY ("active_generation_id") REFERENCES "projection_generations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "projection_reconcile_runs" ADD CONSTRAINT "projection_reconcile_runs_projection_id_fkey" FOREIGN KEY ("projection_id") REFERENCES "source_projections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projection_reconcile_runs" ADD CONSTRAINT "projection_reconcile_runs_projection_version_id_fkey" FOREIGN KEY ("projection_version_id") REFERENCES "source_projection_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projection_reconcile_runs" ADD CONSTRAINT "projection_reconcile_runs_projection_generation_id_fkey" FOREIGN KEY ("projection_generation_id") REFERENCES "projection_generations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "projection_reconcile_runs" ADD CONSTRAINT "projection_reconcile_runs_active_index_generation_id_fkey" FOREIGN KEY ("active_index_generation_id") REFERENCES "index_generations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "projection_reconcile_candidates" ADD CONSTRAINT "projection_reconcile_candidates_reconcile_run_id_fkey" FOREIGN KEY ("reconcile_run_id") REFERENCES "projection_reconcile_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projection_errors" ADD CONSTRAINT "projection_errors_projection_id_fkey" FOREIGN KEY ("projection_id") REFERENCES "source_projections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projection_errors" ADD CONSTRAINT "projection_errors_projection_version_id_fkey" FOREIGN KEY ("projection_version_id") REFERENCES "source_projection_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "projection_errors" ADD CONSTRAINT "projection_errors_projection_generation_id_fkey" FOREIGN KEY ("projection_generation_id") REFERENCES "projection_generations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
