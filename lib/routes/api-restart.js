// lib/routes/api-restart.js
// POST /api/restart — restart the server so saved config changes take effect.
// Used by the Config panel's "Restart now" button. The response is sent before
// teardown begins; the client then polls /api/bootstrap/state and reloads once
// the server is back. See lib/helpers/selfRestart.js for the mechanism.
import logger from "../helpers/logger.js";
import { restartServer, isSupervised } from "../helpers/selfRestart.js";

export function mountRestartRoutes(router) {
  router.post("/restart", (_req, res) => {
    try {
      const { supervised } = restartServer();
      logger.warn("↻ /api/restart requested — restarting now.");
      res.json({ ok: true, supervised });
    } catch (err) {
      logger.error("POST /api/restart error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Lets the UI decide up-front whether a restart will be handled in-place.
  router.get("/restart/capability", (_req, res) => {
    res.json({ supported: true, supervised: isSupervised() });
  });
}
