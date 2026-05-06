import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import conversationsRouter from "./conversations";
import messagesRouter from "./messages";
import notificationsRouter from "./notifications";
import adminRouter from "./admin";
import storageRouter from "./storage";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

// ICE config at the very top, no auth for testing
router.get("/ice-config", (req, res) => {
  console.log("[ICE] Config requested (no-auth mode)");
  const iceServers: any[] = [
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
  ];
  res.json({ iceServers });
});

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(conversationsRouter);
router.use(messagesRouter);
router.use(notificationsRouter);
router.use(adminRouter);
router.use(storageRouter);

export default router;
