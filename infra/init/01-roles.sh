#!/bin/sh
# Cluster-level setup, run once when the volume is first initialized. Schemas,
# grants and marts belong to one database, so the loading app installs them.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v warehouse_password="$WAREHOUSE_PASSWORD" \
  -v agent_password="$AGENT_PASSWORD" <<'SQL'
CREATE ROLE warehouse LOGIN PASSWORD :'warehouse_password';
-- Role settings are defaults a session may change; privileges are the barrier.
CREATE ROLE agent_reader LOGIN NOINHERIT CONNECTION LIMIT 5 PASSWORD :'agent_password';
ALTER ROLE agent_reader SET default_transaction_read_only = on;
ALTER ROLE agent_reader SET statement_timeout = '30s';
ALTER ROLE agent_reader SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE agent_reader SET search_path = marts;
CREATE DATABASE warehouse OWNER warehouse;
SQL
