import { Server as SocketIOServer, type Socket } from "socket.io";
import type { Server as HttpServer } from "http";
import { db, usersTable, UserModel } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyToken } from "./auth";
import { logger } from "./logger";

let io: SocketIOServer | null = null;
const userSockets = new Map<number, Set<string>>();
const activeCalls = new Map<string, {
  callerId: number;
  calleeId: number;
  conversationId: number;
  kind: string;
  startedAt: Date;
}>();

interface SocketData {
  userId: number;
  role: string;
}

export function broadcastPresence(userId: number, status: string): void {
  if (!io) return;
  io.emit("presence", {
    userId,
    status,
    lastSeenAt: new Date().toISOString(),
  });
}

async function setUserStatus(
  userId: number,
  status: "online" | "offline",
): Promise<void> {
  // Try MongoDB first
  try {
    await UserModel.updateOne({ id: userId }, { $set: { status, lastSeenAt: new Date() } });
    return;
  } catch {
    // MongoDB not available, fall through to Drizzle
  }

  // Fallback to Drizzle
  if (db) {
    await db
      .update(usersTable)
      .set({ status, lastSeenAt: new Date() })
      .where(eq(usersTable.id, userId));
  }
}

export function attachRealtime(server: HttpServer): SocketIOServer {
  io = new SocketIOServer(server, {
    path: "/api/socket.io",
    cors: { origin: true, credentials: true },
    serveClient: false,
  });

  io.use((socket, next) => {
    const token =
      (socket.handshake.auth?.["token"] as string | undefined) ??
      (typeof socket.handshake.query?.["token"] === "string"
        ? (socket.handshake.query["token"] as string)
        : undefined);
    if (!token) {
      next(new Error("Missing token"));
      return;
    }
    const payload = verifyToken(token);
    if (!payload) {
      next(new Error("Invalid token"));
      return;
    }
    const numericUserId = Number(payload.sub);
    if (Number.isNaN(numericUserId)) {
      next(new Error("Invalid user ID in token"));
      return;
    }
    (socket.data as SocketData) = { userId: numericUserId, role: payload.role };
    next();
  });

  io.on("connection", (socket: Socket) => {
    const data = socket.data as SocketData;
    const userId = data.userId;
    const room = `user:${userId}`;
    socket.join(room);
    if (data.role === "admin") {
      socket.join("admin");
      process.stdout.write(`[Admin Debug] user=${userId} joined admin room\n`);
    }

    let set = userSockets.get(userId);
    if (!set) {
      set = new Set();
      userSockets.set(userId, set);
    }
    const wasOffline = set.size === 0;
    set.add(socket.id);

    if (wasOffline) {
      (async () => {
        const u = await UserModel.findOne({ id: userId });
        const currentStatus = u?.status || "online";
        
        // If they were truly offline (not just a reconnect), 
        // we might want to update their status if it was "offline"
        if (currentStatus === "offline") {
          await setUserStatus(userId, "online");
          broadcastPresence(userId, "online");
        } else {
          broadcastPresence(userId, currentStatus);
        }
      })().catch((err) => logger.error({ err }, "Failed to sync online status"));
    }

    socket.on(
      "conversation:join",
      (payload: { conversationId: number }) => {
        if (typeof payload?.conversationId === "number") {
          socket.join(`conv:${payload.conversationId}`);
        }
      },
    );

    socket.on(
      "conversation:leave",
      (payload: { conversationId: number }) => {
        if (typeof payload?.conversationId === "number") {
          socket.leave(`conv:${payload.conversationId}`);
        }
      },
    );

    socket.on(
      "typing",
      (payload: { conversationId: number; typing: boolean }) => {
        if (
          typeof payload?.conversationId !== "number" ||
          typeof payload?.typing !== "boolean"
        ) {
          return;
        }
        process.stdout.write(`[Typing Debug] user=${userId} conv=${payload.conversationId} typing=${payload.typing}\n`);
        socket
          .to(`conv:${payload.conversationId}`)
          .emit("typing", {
            conversationId: payload.conversationId,
            userId,
            typing: payload.typing,
          });
      },
    );

    socket.on(
      "call:offer",
      (payload: {
        toUserId: number;
        conversationId: number;
        kind: "audio" | "video";
        sdp: unknown;
        callerName?: string;
      }) => {
        if (
          typeof payload?.toUserId !== "number" ||
          typeof payload?.conversationId !== "number"
        ) {
          return;
        }
        if (!io) return;
        const callId = `${userId}:${payload.toUserId}`;
        activeCalls.set(callId, {
          callerId: userId,
          calleeId: payload.toUserId,
          conversationId: payload.conversationId,
          kind: payload.kind,
          startedAt: new Date(),
        });

        io.to(`user:${payload.toUserId}`).emit("call:offer", {
          fromUserId: userId,
          conversationId: payload.conversationId,
          kind: payload.kind,
          sdp: payload.sdp,
          callerName: payload.callerName ?? null,
        });
      },
    );

    socket.on(
      "call:answer",
      (payload: { toUserId: number; sdp: unknown }) => {
        if (!io || typeof payload?.toUserId !== "number") return;
        io.to(`user:${payload.toUserId}`).emit("call:answer", {
          fromUserId: userId,
          sdp: payload.sdp,
        });
      },
    );

    socket.on(
      "call:ice",
      (payload: { toUserId: number; candidate: unknown }) => {
        if (!io || typeof payload?.toUserId !== "number") return;
        io.to(`user:${payload.toUserId}`).emit("call:ice", {
          fromUserId: userId,
          candidate: payload.candidate,
        });
      },
    );

    socket.on(
      "call:ice-restart",
      (payload: { toUserId: number; sdp: unknown }) => {
        if (!io || typeof payload?.toUserId !== "number") return;
        process.stdout.write(`[Call] ICE restart offer from ${userId} to ${payload.toUserId}\n`);
        io.to(`user:${payload.toUserId}`).emit("call:ice-restart", {
          fromUserId: userId,
          sdp: payload.sdp,
        });
      },
    );

    socket.on(
      "call:relay-needed",
      (payload: { toUserId: number }) => {
        if (!io || typeof payload?.toUserId !== "number") return;
        process.stdout.write(`[Call] Relay needed signal from ${userId} to ${payload.toUserId}\n`);
        io.to(`user:${payload.toUserId}`).emit("call:relay-needed", {
          fromUserId: userId,
        });
      },
    );

    socket.on(
      "call:hangup",
      (payload: { toUserId: number; reason?: string }) => {
        if (!io || typeof payload?.toUserId !== "number") return;
        
        // Remove from active calls
        activeCalls.delete(`${userId}:${payload.toUserId}`);
        activeCalls.delete(`${payload.toUserId}:${userId}`);

        io.to(`user:${payload.toUserId}`).emit("call:hangup", {
          fromUserId: userId,
          reason: payload.reason ?? "ended",
        });
      },
    );

    socket.on("disconnect", () => {
      const s = userSockets.get(userId);
      if (!s) return;
      s.delete(socket.id);
      if (s.size === 0) {
        userSockets.delete(userId);
        void setUserStatus(userId, "offline").catch((err) =>
          logger.error({ err }, "Failed to set user offline"),
        );
        broadcastPresence(userId, "offline");
      }
    });
  });

  return io;
}

export function emitAdminActivity(activity: any): void {
  if (!io) return;
  io.to("admin").emit("admin:activity", activity);
}

export function getOnlineUserIds(): number[] {
  return Array.from(userSockets.keys());
}

export function isUserOnline(userId: number): boolean {
  return userSockets.has(userId);
}

export function emitToUser(userId: number, event: string, data: unknown): void {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
}

export function emitToConversation(
  conversationId: number,
  event: string,
  data: unknown,
): void {
  if (!io) return;
  io.to(`conv:${conversationId}`).emit(event, data);
}

export function emitToUsers(
  userIds: number[],
  event: string,
  data: unknown,
): void {
  if (!io) return;
  for (const id of userIds) {
    io.to(`user:${id}`).emit(event, data);
  }
}

export function getActiveCalls() {
  return Array.from(activeCalls.values());
}
