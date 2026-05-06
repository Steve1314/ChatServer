import type { Request, Response, NextFunction } from "express";
import { verifyToken, findUserById, stripUser } from "../lib/auth";
import type { AuthUser } from "../lib/auth";

/* ✅ Extend Express Request safely */
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    process.stdout.write(`[Auth Debug] Missing or malformed header: "${header}"\n`);
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const token = header.replace("Bearer ", "").trim();
  const payload = verifyToken(token);

  if (!payload) {
    process.stdout.write(`[Auth Debug] Token verification failed for token starting with: "${token.substring(0, 10)}..."\n`);
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  const user = await findUserById(payload.sub);

  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  req.user = stripUser(user);
  next();
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Admin only" });
    return;
  }

  next();
}