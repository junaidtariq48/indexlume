CREATE TABLE "search_presets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "search_index_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "settings_json" JSONB NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "search_presets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "search_presets_search_index_id_name_key" ON "search_presets"("search_index_id", "name");
CREATE INDEX "search_presets_search_index_id_created_at_idx" ON "search_presets"("search_index_id", "created_at" DESC);
ALTER TABLE "search_presets" ADD CONSTRAINT "search_presets_search_index_id_fkey" FOREIGN KEY ("search_index_id") REFERENCES "search_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "search_presets" ADD CONSTRAINT "search_presets_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
