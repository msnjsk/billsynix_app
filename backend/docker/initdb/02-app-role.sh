#!/bin/sh
# First container start: create the API's least-privilege role in both databases.
set -e
for db in "$POSTGRES_DB" billing_test; do
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$db" -f /docker-entrypoint-initdb.d/app-role.psql
done
