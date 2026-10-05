-- app_focus_sessions: One row per time an app came into the foreground, on this Mac or a device it syncs with, from app_focus: when it came in and when it left. A session lasts as long as the app stays in front, used or not: the login window holds it while the Mac is locked, and a watch face while an Apple Watch rests; display_backlight tells when the screen was on.
-- origin: Where it happened: 'local' for this Mac, otherwise the synced device's identifier (devices.deviceId).
-- bundle_id: Bundle identifier of the app in the foreground.
-- started_at: When the app came into the foreground, as a UTC timestamp.
-- ended_at: When it left: the time of the next focus record on the same device, which is its own end or, when that end is missing, the next app's start. NULL while no later record exists, as for the app in the foreground now.
-- seconds: Seconds from started_at to ended_at; NULL when ended_at is.
CREATE TEMP VIEW app_focus_sessions AS
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
  FROM app_focus
)
WHERE started = 1;
