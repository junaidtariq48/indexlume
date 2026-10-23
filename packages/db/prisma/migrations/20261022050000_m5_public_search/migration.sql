ALTER TABLE "projects" ADD COLUMN "public_id" UUID;
UPDATE "projects" SET "public_id" = gen_random_uuid() WHERE "public_id" IS NULL;
ALTER TABLE "projects" ALTER COLUMN "public_id" SET NOT NULL;
ALTER TABLE "projects" ALTER COLUMN "public_id" SET DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX "projects_public_id_key" ON "projects"("public_id");

CREATE TABLE "search_api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "rate_limit_override" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "search_api_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "search_api_keys_key_hash_key" ON "search_api_keys"("key_hash");
CREATE INDEX "search_api_keys_project_id_created_at_idx" ON "search_api_keys"("project_id", "created_at" DESC);
CREATE INDEX "search_api_keys_key_prefix_idx" ON "search_api_keys"("key_prefix");
ALTER TABLE "search_api_keys" ADD CONSTRAINT "search_api_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "search_metric_buckets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "search_index_id" UUID NOT NULL,
    "bucket_start" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "duration_sum_ms" INTEGER NOT NULL DEFAULT 0,
    "duration_le_10" INTEGER NOT NULL DEFAULT 0,
    "duration_le_25" INTEGER NOT NULL DEFAULT 0,
    "duration_le_50" INTEGER NOT NULL DEFAULT 0,
    "duration_le_100" INTEGER NOT NULL DEFAULT 0,
    "duration_le_250" INTEGER NOT NULL DEFAULT 0,
    "duration_le_500" INTEGER NOT NULL DEFAULT 0,
    "duration_le_1000" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "search_metric_buckets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "search_metric_buckets_project_id_search_index_id_bucket_start_key" ON "search_metric_buckets"("project_id", "search_index_id", "bucket_start");
CREATE INDEX "search_metric_buckets_project_id_bucket_start_idx" ON "search_metric_buckets"("project_id", "bucket_start");
ALTER TABLE "search_metric_buckets" ADD CONSTRAINT "search_metric_buckets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "search_metric_buckets" ADD CONSTRAINT "search_metric_buckets_search_index_id_fkey" FOREIGN KEY ("search_index_id") REFERENCES "search_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
