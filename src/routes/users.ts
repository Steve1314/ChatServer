import { Router, type IRouter } from "express";
import { db, usersTable, UserModel } from "@workspace/db";
import { and, eq, ilike, or, sql } from "drizzle-orm";
import {
  CreateUserBody,
  UpdateUserBody,
  ListUsersQueryParams,
} from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../middlewares/auth";
import { hashPassword } from "../lib/auth";
import { serializeUser, serializeUsers } from "../lib/serializers";
import { broadcastPresence } from "../lib/realtime";

const router: IRouter = Router();

const COLORS = [
  "#4f46e5",
  "#0891b2",
  "#16a34a",
  "#ea580c",
  "#db2777",
  "#7c3aed",
  "#0ea5e9",
  "#f59e0b",
  "#10b981",
  "#e11d48",
];

function pickColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(h) % COLORS.length;
  const color = COLORS[idx];
  if (!color) throw new Error("color not found");
  return color;
}

router.get("/users", requireAuth, async (req, res): Promise<void> => {
  const parsed = ListUsersQueryParams.safeParse(req.query);
  const q = parsed.success ? parsed.data.q : undefined;

  let rows: any[] = [];

  // Try MongoDB
  try {
    const filter: any = {};
    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { email: { $regex: q, $options: "i" } },
        { title: { $regex: q, $options: "i" } },
      ];
    }
    rows = await UserModel.find(filter).sort({ name: 1 });
  } catch (err) {
    // MongoDB failed, fallback to Drizzle
    if (db) {
      rows = q
        ? await db
          .select()
          .from(usersTable)
          .where(
            or(
              ilike(usersTable.name, `%${q}%`),
              ilike(usersTable.email, `%${q}%`),
              ilike(sql`COALESCE(${usersTable.title}, '')`, `%${q}%`),
            ),
          )
          .orderBy(usersTable.name)
        : await db.select().from(usersTable).orderBy(usersTable.name);
    }
  }

  const userMap = await serializeUsers(rows.map((r) => r.id));
  const ordered = rows.map((r) => userMap.get(r.id)).filter((v) => v != null);
  res.json(ordered);
});

router.post(
  "/users",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = CreateUserBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const { email, name, password, role, title } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    // Check MongoDB first
    const existingMongo = await UserModel.findOne({ email: normalizedEmail });
    if (existingMongo) {
      res.status(400).json({ error: "Email already in use" });
      return;
    }

    const passwordHash = await hashPassword(password);

    // Create in MongoDB
    const u = await UserModel.create({
      email: normalizedEmail,
      name,
      passwordHash,
      role,
      title: title ?? undefined,
      avatarColor: pickColor(normalizedEmail),
    });

    // Also sync to Drizzle if available
    if (db) {
      try {
        await db.insert(usersTable).values({
          id: u.id,
          email: normalizedEmail,
          name,
          passwordHash,
          role,
          title: title ?? null,
          avatarColor: u.avatarColor,
        });
      } catch (err) { }
    }

    const out = await serializeUser(u.id);
    res.status(201).json(out);
  },
);

router.patch(
  "/users/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw ?? "", 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = UpdateUserBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const isSelf = req.user!.id === id;
    const isAdmin = req.user!.role === "admin";
    if (!isSelf && !isAdmin) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const updates: any = {};
    if (parsed.data.name != null) updates.name = parsed.data.name;
    if (parsed.data.title !== undefined) updates.title = parsed.data.title;
    if (parsed.data.role != null) {
      if (!isAdmin) {
        res.status(403).json({ error: "Only admins can change roles" });
        return;
      }
      updates.role = parsed.data.role;
    }
    if (parsed.data.password) {
      updates.passwordHash = await hashPassword(parsed.data.password);
    }
    if (parsed.data.status) {
      updates.status = parsed.data.status;
    }

    if (Object.keys(updates).length > 0) {
      // Update MongoDB
      const u = await UserModel.findOneAndUpdate({ id }, { $set: updates }, { returnDocument: "after" });
      if (!u && !db) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      if (db) {
        await db.update(usersTable).set(updates).where(eq(usersTable.id, id));
      }

      if (updates.status) {
        broadcastPresence(id, updates.status);
      }
    }

    const out = await serializeUser(id);
    if (!out) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(out);
  },
);

router.delete(
  "/users/:id",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw ?? "", 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    if (id === req.user!.id) {
      res.status(400).json({ error: "Cannot delete yourself" });
      return;
    }

    // Delete from MongoDB
    await UserModel.deleteOne({ id });

    // Delete from Drizzle if available
    if (db) {
      await db.delete(usersTable).where(eq(usersTable.id, id));
    }

    res.status(204).send();
  },
);

export default router;
