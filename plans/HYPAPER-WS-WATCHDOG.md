# HYPAPER-WS-WATCHDOG — a silent HL WebSocket is detected and reconnected

- status: done (2026-10-15; codex review cycle 2 approve 5/5, patch 8a4a733c)
- found: on the AWS host, image im-21ceef2, the HL WebSocket went half-open at about 08:32Z on 10-15. Main-dex `allMids`, and every valuation that reads them (`clearinghouseState` accountValue, maintenance margin), stayed frozen for about 6 hours with no log line, while xyz kept moving because it is polled over HTTP every 15 s. The StatArb_Crypto PAPER book HALTed on the gap between its live-mark margin and HyPaper's frozen figure. A container restart at 14:31Z cleared it.
- cause: `src/worker/ws-client.ts` reconnects only on a `close` or `error` event. It sends no heartbeat and does not track how long it has gone without a message, so a half-open TCP connection never triggers a reconnect.

## Acceptance

1. **Watchdog.** The client records the arrival time of every message. If no message arrives for `WS_SILENCE_MS` (config, default 30000), it logs a warning naming the silence, terminates the socket (`terminate()`, not a graceful close), and goes through the existing reconnect and backoff path. On reconnect it re-sends every subscription. A clean reconnect resets the backoff as today.
2. **Heartbeat.** The client sends HL's application-level `{"method":"ping"}` every `WS_PING_MS` (default 20000). A `pong` counts as a message for the watchdog.
3. **Staleness signal.** The worker publishes, per subscription family (main-dex `allMids`, each extra dex's `allMids`, the main-dex mark subscriptions), the time of the last update, in redis under a documented key. The existing `/health` endpoint (or a new read-only `/health/feeds`) returns those times and the age of each. Nothing synthesizes a price; a stale feed is reported as stale.
4. **Tests.** A fake WS server that goes silent without closing triggers terminate, reconnect and resubscription within `WS_SILENCE_MS` plus the backoff. A server answering pings never trips the watchdog. Fake timers only, no wall-clock sleeps. The feed-age endpoint is tested for fresh and stale feeds.
5. **Docs.** The README or the ops doc gives the two new config keys and the health fields.

- allowed_paths: src/worker/ws-client.ts, src/worker/index.ts, src/worker/price-updater.ts, src/config.ts, src/api/routes/health* (or the existing health route), tests/**, README.md / docs/**.
- out of scope: changing which feeds are used, HTTP polling of the main dex, alerting into Slack (the tholos side can read the health endpoint), any change to order matching or valuation logic.
- deploy: a new image tag, swapped on the host in a HyPaper restart window (never 15:30–15:52 ET, never :15–:30, never mid-pair), with the template refresh the redeploy rule requires.
