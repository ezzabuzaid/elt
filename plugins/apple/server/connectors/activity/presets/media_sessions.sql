-- media_sessions: One row per playback an app reported, on this Mac, from media_usage: Biome writes its start and its stop with one usageId.
-- origin: Where it happened: 'local' for this Mac.
-- usage_id: The playback's identifier (media_usage.usageId).
-- bundle_id: Bundle identifier of the app that played media.
-- started_at: When playback started, as a UTC timestamp; NULL when its start is not loaded.
-- ended_at: When playback stopped; NULL while it plays or when its stop is not loaded.
-- seconds: Seconds from started_at to ended_at; NULL when either is.
CREATE TEMP VIEW media_sessions AS
SELECT
  origin,
  usage_id,
  bundle_id,
  started_at,
  ended_at,
  round((julianday(ended_at) - julianday(started_at)) * 86400, 3) AS seconds
FROM (
  SELECT
    origin,
    "usageId" AS usage_id,
    max("bundleId") AS bundle_id,
    min(CASE WHEN started = 1 THEN "occurredAt" END) AS started_at,
    max(CASE WHEN started = 0 THEN "occurredAt" END) AS ended_at
  FROM media_usage
  GROUP BY origin, "usageId"
);
