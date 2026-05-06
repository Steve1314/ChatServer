import { db, usersTable, UserModel } from "@workspace/db";
import { eq } from "drizzle-orm";
import { hashPassword } from "./auth";
import { logger } from "./logger";

const ADMIN_EMAIL = "admin@vahlayconsulting.com";
const ADMIN_PASSWORD = "Vahlay@2025";

export async function ensureSeedData(): Promise<void> {
  // Seed MongoDB
  try {
    const existingMongo = await UserModel.findOne({ email: ADMIN_EMAIL.toLowerCase().trim() });
    if (!existingMongo) {
      const passwordHash = await hashPassword(ADMIN_PASSWORD);
      await UserModel.create({
        email: ADMIN_EMAIL,
        name: "Vahlay Admin",
        passwordHash,
        role: "admin",
        title: "Workspace Administrator",
        avatarColor: "#4f46e5",
      });
      logger.info({ email: ADMIN_EMAIL }, "Seeded admin user in MongoDB");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to seed MongoDB (maybe not connected?)");
  }

  // Seed Drizzle (Postgres) if connected
  if (db) {
    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, ADMIN_EMAIL));
    if (existing) {
      if (existing.role !== "admin") {
        await db
          .update(usersTable)
          .set({ role: "admin" })
          .where(eq(usersTable.id, existing.id));
      }
    } else {
      const passwordHash = await hashPassword(ADMIN_PASSWORD);
      await db.insert(usersTable).values({
        email: ADMIN_EMAIL,
        name: "Vahlay Admin",
        passwordHash,
        role: "admin",
        title: "Workspace Administrator",
        avatarColor: "#4f46e5",
      });
      logger.info({ email: ADMIN_EMAIL }, "Seeded admin user in Postgres");
    }
  }
}
