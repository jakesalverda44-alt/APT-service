#!/usr/bin/env bash
# Apply service-program migrations, in order, exactly once each.
# Usage: DATABASE_URL=postgres://... ./database/migrate.sh
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to the shared Postgres connection string}"
cd "$(dirname "$0")"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS service;
CREATE TABLE IF NOT EXISTS service.schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

for f in migrations/*.sql; do
  name="$(basename "$f")"
  applied=$(psql "$DATABASE_URL" -tA -c \
    "SELECT 1 FROM service.schema_migrations WHERE filename = '$name'")
  if [ "$applied" = "1" ]; then
    echo "skip  $name"
    continue
  fi
  echo "apply $name"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -1 -f "$f"
  psql "$DATABASE_URL" -q -c \
    "INSERT INTO service.schema_migrations (filename) VALUES ('$name')"
done
echo "done"
