# End-to-End Tests

End-to-end tests exercise Aperio through real child processes, ports, HTTP, and WebSocket connections. `bootstrap/` covers startup helpers, `real-app/` runs the production app fixture, `websocket/` covers protocol and lifecycle behavior, and `ui/` checks browser-facing server output without requiring a browser. Shared process fixtures remain in `fixtures/`, while connection and process helpers remain in `helpers/`; run the tier with `npm run test:e2e`.
