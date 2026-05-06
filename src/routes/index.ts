import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import conversationsRouter from "./conversations";
import messagesRouter from "./messages";
import notificationsRouter from "./notifications";
import adminRouter from "./admin";
import storageRouter from "./storage";
import callRouter from "./call";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use("/call", callRouter);
router.use(usersRouter);
router.use(conversationsRouter);
router.use(messagesRouter);
router.use(notificationsRouter);
router.use(adminRouter);
router.use(storageRouter);

export default router;
