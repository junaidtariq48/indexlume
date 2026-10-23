-- Drafts exist before catalog validation; only validated/published versions require a fingerprint.
ALTER TABLE "source_projection_versions" ALTER COLUMN "schema_fingerprint" DROP NOT NULL;
