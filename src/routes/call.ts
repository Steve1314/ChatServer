import { Router } from "express";
import { requireAuth } from "../middlewares/auth";
import { getActiveCalls } from "../lib/realtime";

const router = Router();

/**
 * GET /api/call/active
 * Returns a list of currently active calls tracked by the server.
 */
router.get("/active", requireAuth, (_req, res) => {
  res.json({ calls: getActiveCalls() });
});

/**
 * GET /api/call/ice-config
 * Returns ICE server configuration for WebRTC.
 */
router.get("/ice-config", (req, res) => {
  const meteredKey = process.env.METERED_API_KEY;
  const meteredDomain = process.env.METERED_DOMAIN;

  const iceServers: any[] = [];

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
    // Public fallbacks
    iceServers.push(
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com" },
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
      }
    );
  }

  res.json({ iceServers });
});

export default router;
