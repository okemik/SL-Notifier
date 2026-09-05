# Review fixes

The user approved correcting the four preceding findings. External cron requests run every 60 seconds; hosting and cron configuration are outside this change.

Keep the providers and SQLite queue. Reject MyMemory application errors and blank chunk results before caching. Split at Unicode code-point boundaries within 500 UTF-8 bytes, preferring spaces. Construct LibreTranslate once during startup so notifications share its cache.

Notifier.stop must mean its active check has settled. Move the ten-second deadline to service shutdown: stop HTTP admission and abort polling, acknowledge completed sends before closing SQLite, then wait for HTTP connections. If draining exceeds the deadline, terminate with failure while SQLite remains open for any still-running check. Abrupt termination can still leave a Telegram delivery unacknowledged, as already documented.

Alternatives: removing the deadline permits indefinite shutdown; retaining it inside Notifier.stop permits late database access. A service-level deadline preserves bounded exit and storage ordering.

Validate mocked provider responses, Unicode request sizes, a delayed send against in-memory SQLite, graceful/expired HTTP shutdown, and the complete test/typecheck/build suite. No real Telegram messages or deployment.
