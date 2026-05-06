import { Router, type IRouter } from "express";
import { db, usersTable, UserModel } from "@workspace/db";
import { eq } from "drizzle-orm";
import { LoginBody } from "@workspace/api-zod";
import {
  signToken,
  verifyPassword,
  stripUser,
} from "../lib/auth";
import { requireAuth } from "../middlewares/auth";
import { serializeUser } from "../lib/serializers";
import { normalizeMongoUser } from "../lib/mongo-mapper";

const router: IRouter = Router();

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { email, password } = parsed.data;
  
  let user: any = null;
  
  // Try MongoDB first
  try {
    const mongoUser = await UserModel.findOne({ email: email.toLowerCase().trim() });
    if (mongoUser) {
      user = normalizeMongoUser(mongoUser);
    }
  } catch (err) {
    // MongoDB failed or not configured
  }
  
  // Fallback to Postgres if Drizzle is connected and user not found in Mongo
  if (!user && db) {
    const [dbUser] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email.toLowerCase().trim()));
    user = dbUser;
  }

  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  
  const safe = stripUser(user);
  const token = signToken(safe);
  
  // Note: serializeUser might need update for MongoDB IDs
  const enriched = await serializeUser(user.id || user._id.toString());
  res.json({ token, user: enriched });
});

router.post("/auth/logout", (_req, res): void => {
  res.status(204).send();
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const u = await serializeUser(req.user!.id);
  if (!u) {
    res.status(401).json({ error: "User not found" });
    return;
  }
  res.json(u);
});

export default router;
