import { Router } from "express";
import { requireAuth } from "../middlewares/auth";

const router = Router();

/**
 * GET /api/ice-config
 * Returns ICE server configuration for WebRTC.
 * Uses Metered.ca TURN servers if env vars are set,
 * otherwise falls back to public STUN/TURN servers.
 */
router.get("/ice-config", requireAuth, (_req, res) => {
  console.log("[ICE] Config requested by user:", _req.user?.id);
  const iceServers: any[] = [];

  // If a custom Metered account is configured, use it
  const meteredKey = process.env.METERED_API_KEY;
  const meteredDomain = process.env.METERED_DOMAIN; // e.g. "yourapp.metered.live"

  if (meteredKey && meteredDomain) {
    iceServers.push(
      { urls: `stun:${meteredDomain}` },
      {
        urls: `turn:${meteredDomain}:80`,
        username: meteredKey,
        credential: meteredKey,
      },
      {
        urls: `turn:${meteredDomain}:443`,
        username: meteredKey,
        credential: meteredKey,
      },
      {
        urls: `turn:${meteredDomain}:443?transport=tcp`,
        username: meteredKey,
        credential: meteredKey,
      },
    );
  } else {
    // Public fallbacks – reliable enough for LAN/same-network calls
    iceServers.push(
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com" },
      // openrelay free TURN – works for relay when peers are on different networks
      {
        urls: "turn:openrelay.metered.ca:80",
        username: "openrelayproject",
        credential: "openrelayproject",
      },
      {
        urls: "turn:openrelay.metered.ca:443",
        username: "openrelayproject",
        credential: "openrelayproject",
      },
      {
        urls: "turns:openrelay.metered.ca:443",
        username: "openrelayproject",
        credential: "openrelayproject",
      },
      {
        urls: "turn:openrelay.metered.ca:443?transport=tcp",
        username: "openrelayproject",
        credential: "openrelayproject",
      },
    );
  }

  res.json({ iceServers });
});

export default router;
