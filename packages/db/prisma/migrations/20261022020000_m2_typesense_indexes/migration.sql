CREATE TYPE "TypesenseConnectionMode" AS ENUM ('BUNDLED', 'EXTERNAL');
CREATE TYPE "TypesenseTlsPolicy" AS ENUM ('STRICT', 'ALLOW_INSECURE');
CREATE TYPE "SearchIndexState" AS ENUM ('CREATING', 'READY', 'ERROR');
CREATE TYPE "IndexGenerationState" AS ENUM ('CREATING', 'ACTIVE', 'FAILED');

ALTER TABLE "projects" ADD COLUMN "typesense_connection_id" UUID;

CREATE TABLE "typesense_connections" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "TypesenseConnectionMode" NOT NULL,
    "endpoint" TEXT NOT NULL,
    "encrypted_api_key" TEXT NOT NULL,
    "tls_policy" "TypesenseTlsPolicy" NOT NULL DEFAULT 'STRICT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "typesense_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "search_indexes" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "mapping_json" JSONB NOT NULL,
    "search_defaults_json" JSONB NOT NULL DEFAULT '{}',
    "active_generation" INTEGER,
    "state" "SearchIndexState" NOT NULL DEFAULT 'CREATING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "search_indexes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "index_generations" (
    "id" UUID NOT NULL,
    "search_index_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "physical_collection" TEXT NOT NULL,
    "state" "IndexGenerationState" NOT NULL DEFAULT 'CREATING',
    "record_count" INTEGER NOT NULL DEFAULT 0,
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "index_generations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "projects_typesense_connection_id_idx" ON "projects"("typesense_connection_id");
CREATE UNIQUE INDEX "typesense_connections_workspace_id_name_key" ON "typesense_connections"("workspace_id", "name");
CREATE INDEX "typesense_connections_workspace_id_idx" ON "typesense_connections"("workspace_id");
CREATE UNIQUE INDEX "search_indexes_alias_key" ON "search_indexes"("alias");
CREATE UNIQUE INDEX "search_indexes_project_id_slug_key" ON "search_indexes"("project_id", "slug");
CREATE INDEX "search_indexes_project_id_idx" ON "search_indexes"("project_id");
CREATE UNIQUE INDEX "index_generations_physical_collection_key" ON "index_generations"("physical_collection");
CREATE UNIQUE INDEX "index_generations_search_index_id_generation_key" ON "index_generations"("search_index_id", "generation");
CREATE INDEX "index_generations_search_index_id_created_at_idx" ON "index_generations"("search_index_id", "created_at" DESC);

ALTER TABLE "projects" ADD CONSTRAINT "projects_typesense_connection_id_fkey" FOREIGN KEY ("typesense_connection_id") REFERENCES "typesense_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "typesense_connections" ADD CONSTRAINT "typesense_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "search_indexes" ADD CONSTRAINT "search_indexes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "index_generations" ADD CONSTRAINT "index_generations_search_index_id_fkey" FOREIGN KEY ("search_index_id") REFERENCES "search_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
