-- web_visits: One row per web page visit Screen Time counted, on this Mac, from web_usage: Biome writes its start (usage state 2) and its end (state 1) with one usageId.
-- origin: Where it happened: 'local' for this Mac.
-- usage_id: The visit's identifier (web_usage.usageId).
-- url: The page URL.
-- domain: The web domain Screen Time counts.
-- bundle_id: Bundle identifier of the browser.
-- safari_profile_id: The Safari profile the page was open in; NULL when none was recorded.
-- started_at: When the visit started, as a UTC timestamp; NULL when its start is not loaded.
-- ended_at: When it ended; NULL while the page is open or when its end is not loaded.
-- seconds: Seconds from started_at to ended_at; NULL when either is.
CREATE TEMP VIEW web_visits AS
SELECT
  origin,
  usage_id,
  url,
  domain,
  bundle_id,
  safari_profile_id,
  started_at,
  ended_at,
  round((julianday(ended_at) - julianday(started_at)) * 86400, 3) AS seconds
FROM (
  SELECT
    origin,
    "usageId" AS usage_id,
    max(url) AS url,
    max(domain) AS domain,
    max("bundleId") AS bundle_id,
    max("safariProfileId") AS safari_profile_id,
    min(CASE WHEN "usageState" = 2 THEN "occurredAt" END) AS started_at,
    max(CASE WHEN "usageState" = 1 THEN "occurredAt" END) AS ended_at
  FROM web_usage
  GROUP BY origin, "usageId"
);
