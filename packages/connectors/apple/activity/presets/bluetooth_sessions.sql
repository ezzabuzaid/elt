-- bluetooth_sessions: One row per time a Bluetooth device connected, on this Mac or a device it syncs with, from bluetooth_connections: when it connected and when it disconnected.
-- origin: Where it happened: 'local' for this Mac, otherwise the synced device's identifier (devices.deviceId).
-- address: Bluetooth address of the device.
-- device_name: Name of the device; NULL when it had none.
-- started_at: When the device connected, as a UTC timestamp.
-- ended_at: When it disconnected: the next record of the same device when that record is a disconnection. NULL while it is connected, or when the next record is another connection.
-- seconds: Seconds from started_at to ended_at; NULL when ended_at is.
CREATE TEMP VIEW bluetooth_sessions AS
SELECT
  origin,
  address,
  device_name,
  started_at,
  ended_at,
  round((julianday(ended_at) - julianday(started_at)) * 86400, 3) AS seconds
FROM (
  SELECT
    origin,
    address,
    "deviceName" AS device_name,
    connected,
    "recordedAt" AS started_at,
    CASE WHEN lead(connected) OVER next = 0 THEN lead("recordedAt") OVER next END AS ended_at
  FROM bluetooth_connections
  WINDOW next AS (PARTITION BY origin, address ORDER BY "recordedAt", segment, slot)
)
WHERE connected = 1;
