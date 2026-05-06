import { Router, type IRouter } from "express";
import { NotificationModel } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get(
  "/notifications",
  requireAuth,
  async (req, res): Promise<void> => {
    const me = req.user!.id;
    const rows = await NotificationModel.find({ userId: me })
      .sort({ id: -1 })
      .limit(100);
    res.json(
      rows.map((n: any) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        conversationId: n.conversationId,
        messageId: n.messageId,
        readAt: n.readAt ? n.readAt.toISOString() : null,
        createdAt: n.createdAt.toISOString(),
      })),
    );
  },
);

router.post(
  "/notifications/read-all",
  requireAuth,
  async (req, res): Promise<void> => {
    const me = req.user!.id;
    await NotificationModel.updateMany(
      { userId: me, readAt: null },
      { $set: { readAt: new Date() } },
    );
    res.status(204).send();
  },
);

export default router;
