#!/bin/sh
# The reader's contract belongs to the warehouse database, so it runs there
# rather than in POSTGRES_DB. The SQL sits in a subfolder, which the image
# does not run on its own.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname warehouse \
  -f /docker-entrypoint-initdb.d/marts/contract.sql
