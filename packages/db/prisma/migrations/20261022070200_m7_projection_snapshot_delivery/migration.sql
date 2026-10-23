ALTER TABLE "projection_generations"
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "started_at" TIMESTAMP(3),
  ADD COLUMN "completed_at" TIMESTAMP(3);

UPDATE "projection_generations"
SET "idempotency_key" = 'legacy-' || "id"::text
WHERE "idempotency_key" IS NULL;

ALTER TABLE "projection_generations"
  ALTER COLUMN "idempotency_key" SET NOT NULL;

CREATE UNIQUE INDEX "projection_generations_idempotency_key_key"
  ON "projection_generations"("idempotency_key");
