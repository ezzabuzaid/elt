-- screen_time_sessions: One row per stretch of app usage Screen Time counts on this Mac, from screen_time_app_usage: when it started and when it ended. Unlike app_focus_sessions it leaves out system interface such as the Dock and the login window.
-- origin: Where it happened: 'local' for this Mac.
-- bundle_id: Bundle identifier of the app in use.
-- started_at: When usage started, as a UTC timestamp.
-- ended_at: When it ended: the time of the next usage record, which is its own end or, when that end is missing, the next app's start. NULL while no later record exists.
-- seconds: Seconds from started_at to ended_at; NULL when ended_at is.
CREATE TEMP VIEW screen_time_sessions AS
-- One app switch writes the app left and the app entered at one instant, in
-- that slot order, so records are ordered by time, then segment and slot.
SELECT
  origin,
  bundle_id,
  started_at,
  ended_at,
  round((julianday(ended_at) - julianday(started_at)) * 86400, 3) AS seconds
FROM (
  SELECT
    origin,
    "bundleId" AS bundle_id,
    started,
    "occurredAt" AS started_at,
    lead("occurredAt") OVER (PARTITION BY origin ORDER BY "recordedAt", segment, slot) AS ended_at
  FROM screen_time_app_usage
)
WHERE started = 1;
