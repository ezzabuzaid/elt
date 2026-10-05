-- focus_mode_spans: One row per time a Focus turned on, on this Mac, from focus_modes: when it turned on and when it turned off.
-- origin: Where it happened: 'local' for this Mac.
-- mode_id: Identifier of the configured Focus (focus_modes.modeId).
-- semantic_mode_id: What kind of Focus it is, such as com.apple.focus.work or com.apple.sleep.sleep-mode.
-- started_at: When the Focus turned on, as a UTC timestamp.
-- ended_at: When it turned off: the next record of the same Focus when that record turns it off. NULL while it is on, or when the next record turns it on again.
-- seconds: Seconds from started_at to ended_at; NULL when ended_at is.
CREATE TEMP VIEW focus_mode_spans AS
SELECT
  origin,
  mode_id,
  semantic_mode_id,
  started_at,
  ended_at,
  round((julianday(ended_at) - julianday(started_at)) * 86400, 3) AS seconds
FROM (
  SELECT
    origin,
    "modeId" AS mode_id,
    "semanticModeId" AS semantic_mode_id,
    started,
    "recordedAt" AS started_at,
    CASE WHEN lead(started) OVER next = 0 THEN lead("recordedAt") OVER next END AS ended_at
  FROM focus_modes
  WINDOW next AS (PARTITION BY origin, "modeId" ORDER BY "recordedAt", segment, slot)
)
WHERE started = 1;
