ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_triggered_by_id_fkey" FOREIGN KEY ("triggered_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
