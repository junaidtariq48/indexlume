# Encryption-key rotation

Indexlume uses versioned AES-256-GCM envelopes. New writes include a non-secret key identifier. Existing `v1` envelopes remain readable while their key is listed in `APP_ENCRYPTION_KEY_PREVIOUS`.

Projection identity HMACs and public search-key hashes must not change during encryption rotation. Configure `APP_HMAC_KEY` and `SEARCH_KEY_PEPPER` as independent, stable 32-byte base64 values before the first production deployment. Existing deployments must initially set both values to the current `APP_ENCRYPTION_KEY` before changing that encryption key.

## Rotation procedure

1. Back up PostgreSQL metadata and retain the current encryption key in the deployment secret manager.
2. Stop API and worker writes. Allow running uploads and ingestion jobs to finish; staged upload files use the key active when they were uploaded.
3. Set `APP_HMAC_KEY` and `SEARCH_KEY_PEPPER` to their existing stable values.
4. Generate a new 32-byte base64 encryption key. Set it as `APP_ENCRYPTION_KEY` and put the old key in `APP_ENCRYPTION_KEY_PREVIOUS`. Multiple previous keys are comma-separated.
5. Validate every stored envelope without writing:

   ```sh
   pnpm crypto:rotate:check
   ```

6. Rewrap stored credentials and protected projection keys:

   ```sh
   pnpm crypto:rotate
   ```

7. Restart the API and worker. Test every Typesense connection, PostgreSQL source, active projection, and an existing public search key.
8. Run `pnpm crypto:rotate:check` again. Every scanned database record must report `alreadyActive`; `rewrapped` must be zero.
9. Remove the old value from `APP_ENCRYPTION_KEY_PREVIOUS` and restart services.

The same commands can be run from the built Compose application image, which intentionally does not contain pnpm:

```sh
docker compose run --rm --no-deps api node infra/rotate-encryption-key.mjs
docker compose run --rm --no-deps api node infra/rotate-encryption-key.mjs --apply
```

The command never prints plaintext or key material. It reports only the active key identifier and record counts. If dry-run cannot decrypt any value, do not apply the rotation; restore the missing previous key first.

## Search-key pepper rotation

Search-key hashes cannot be rewrapped because the plaintext key is intentionally never stored. To rotate `SEARCH_KEY_PEPPER`, add the old pepper to `SEARCH_KEY_PEPPER_PREVIOUS`, deploy the new pepper, and issue replacement search keys. Revoke all keys created under the old pepper before removing it from the previous list.

## HMAC-key rotation

`APP_HMAC_KEY` protects deterministic lookup identifiers used by relational projections. It is intentionally independent from envelope encryption. Rotating it requires an offline rebuild of all projection HMAC identities and indexes and is not part of routine encryption-key rotation. Keep it in the same durable secret-management tier as the encryption key.
