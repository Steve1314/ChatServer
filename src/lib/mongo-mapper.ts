import type { User } from "@workspace/db";

/**
 * Converts Mongo user → DB-compatible User shape
 */
export function normalizeMongoUser(user: any): User {
  const numericId = user.id ?? (typeof user._id === 'number' ? user._id : NaN);
  
  return {
    id: !isNaN(numericId) ? numericId : 0, // Fallback to 0 if no numeric ID found
    email: user.email,
    name: user.name,
    passwordHash: user.passwordHash,
    role: user.role,

    // 🔥 FIX HERE (undefined → null)
    title: user.title ?? null,

    avatarColor: user.avatarColor,
    status: user.status,
    lastSeenAt: user.lastSeenAt ?? null,
    createdAt: user.createdAt,
  };
}
