import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db, usersTable, type User, UserModel } from "@workspace/db";
import { eq } from "drizzle-orm";
import { normalizeMongoUser } from "./mongo-mapper";
const SECRET = process.env.SESSION_SECRET;
if (!SECRET) throw new Error("SESSION_SECRET is required");

const JWT_SECRET: string = SECRET;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

/* ---------------- TYPES ---------------- */

export type AuthUser = Omit<User, "passwordHash">;

export interface JwtPayload {
  sub: string; // ✅ FIXED (string for Mongo + SQL compatibility)
  role: string;
  iat?: number;
  exp?: number;
}

/* ---------------- AUTH ---------------- */

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/* ---------------- TOKEN ---------------- */

export function signToken(user: AuthUser): string {
  const payload: JwtPayload = {
    sub: String(user.id), // ✅ always string
    role: user.role,
  };

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (
      typeof decoded !== "object" ||
      decoded === null ||
      (typeof (decoded as any).sub !== "string" && typeof (decoded as any).sub !== "number") ||
      typeof (decoded as any).role !== "string"
    ) {
      return null;
    }

    return {
      ...(decoded as any),
      sub: String((decoded as any).sub),
    } as JwtPayload;
  } catch {
    return null;
  }
}

/* ---------------- USER HELPERS ---------------- */

export function stripUser(u: User): AuthUser {
  const { passwordHash: _, ...rest } = u;
  return rest;
}

/**
 * Supports:
 * - Mongo (_id string)
 * - SQL (number id)
 */


export async function findUserById(id: string): Promise<User | null> {
  if (!id || id === "undefined" || id === "NaN") {
    process.stdout.write(`[Auth Debug] Rejecting invalid ID in token: "${id}"\n`);
    return null;
  }

  try {
    const numericId = parseInt(id, 10);
    const isNumericOnly = !isNaN(numericId) && /^\d+$/.test(id);
    const isMongoObjectId = /^[0-9a-f]{24}$/i.test(id);

    let query: any;
    if (isNumericOnly) {
      // Plain numeric ID (e.g. "1") — only search by the numeric id field, NEVER _id
      query = { id: numericId };
    } else if (isMongoObjectId) {
      // Looks like a real MongoDB ObjectId hex string
      query = { _id: id };
    } else {
      // Unknown format — try both but _id won't cast so skip it
      query = { id: numericId };
    }

    const mongoUser = await UserModel.findOne(query);
    if (mongoUser) {
      return normalizeMongoUser(mongoUser);
    }
  } catch (err) {
    process.stdout.write(`[Auth Debug] MongoDB lookup failed: ${err}\n`);
  }

  if (db) {
    const numericId = Number(id);

    if (!Number.isNaN(numericId)) {
      const [u] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, numericId));

      return u ?? null;
    }
  }

  return null;
}