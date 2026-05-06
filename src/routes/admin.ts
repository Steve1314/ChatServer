import { Router, type IRouter } from "express";
import {
  db,
  usersTable,
  conversationsTable,
  conversationMembersTable,
  messagesTable,
  UserModel,
  ConversationModel,
  MessageModel,
} from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { requireAdmin, requireAuth } from "../middlewares/auth";
import { serializeConversations, serializeUsers } from "../lib/serializers";
import { getOnlineUserIds, getActiveCalls } from "../lib/realtime";

const router: IRouter = Router();

router.get(
  "/admin/stats",
  requireAuth,
  requireAdmin,
  async (_req, res): Promise<void> => {
    let totalUsers = 0;
    let totalConvs = 0;
    let totalGroups = 0;
    let totalMessages = 0;
    let messagesToday = 0;
    let topTalkersRows: any[] = [];

    if (db) {
      const [users] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(usersTable);
      const [convs] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(conversationsTable);
      const [groups] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(conversationsTable)
        .where(eq(conversationsTable.kind, "group"));
      const [messages] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(messagesTable);
      const [today] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(messagesTable)
        .where(sql`${messagesTable.createdAt} > NOW() - INTERVAL '24 hours'`);

      topTalkersRows = await db
        .select({
          authorId: messagesTable.authorId,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(messagesTable)
        .where(sql`${messagesTable.deletedAt} IS NULL`)
        .groupBy(messagesTable.authorId)
        .orderBy(desc(sql`COUNT(*)`))
        .limit(5);

      totalUsers = users?.count ?? 0;
      totalConvs = convs?.count ?? 0;
      totalGroups = groups?.count ?? 0;
      totalMessages = messages?.count ?? 0;
      messagesToday = today?.count ?? 0;
    } else {
      // Fallback to MongoDB
      totalUsers = await UserModel.countDocuments();
      totalConvs = await ConversationModel.countDocuments();
      totalGroups = await ConversationModel.countDocuments({ kind: "group" });
      totalMessages = await MessageModel.countDocuments({ deletedAt: null });
      messagesToday = await MessageModel.countDocuments({ 
        deletedAt: null, 
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } 
      });

      const topTalkers = await MessageModel.aggregate([
        { $match: { deletedAt: null } },
        { $group: { _id: "$authorId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 }
      ]);
      topTalkersRows = topTalkers.map(t => ({ authorId: t._id, count: t.count }));
    }

    const onlineIds = getOnlineUserIds();
    const userMap = await serializeUsers(topTalkersRows.map((r: any) => r.authorId));
    res.json({
      totalUsers,
      onlineUsers: onlineIds.length,
      totalConversations: totalConvs,
      totalGroups: totalGroups,
      totalMessages,
      messagesToday,
      topUsers: topTalkersRows
        .map((r: any) => {
          const u = userMap.get(r.authorId);
          if (!u) return null;
          return { user: u, messageCount: r.count };
        })
        .filter((v: any) => v !== null),
    });
  },
);

router.get(
  "/admin/conversations",
  requireAuth,
  requireAdmin,
  async (_req, res): Promise<void> => {
    let list = [];
    if (db) {
      const all = await db
        .select({ id: conversationsTable.id })
        .from(conversationsTable)
        .orderBy(desc(conversationsTable.updatedAt));
      list = await serializeConversations(
        all.map((c: any) => c.id),
        null,
      );
    } else {
      const all = await ConversationModel.find().sort({ updatedAt: -1 });
      list = await serializeConversations(
        all.map((c: any) => c.id),
        null,
      );
    }
    res.json(list);
  },
);

router.get(
  "/admin/activity",
  requireAuth,
  requireAdmin,
  async (_req, res): Promise<void> => {
    let recentMessages: any[] = [];
    if (db) {
      recentMessages = await db
        .select({
          id: messagesTable.id,
          authorId: messagesTable.authorId,
          conversationId: messagesTable.conversationId,
          content: messagesTable.content,
          createdAt: messagesTable.createdAt,
        })
        .from(messagesTable)
        .where(sql`${messagesTable.deletedAt} IS NULL`)
        .orderBy(desc(messagesTable.id))
        .limit(50);
    } else {
      recentMessages = await MessageModel.find({ deletedAt: null })
        .sort({ id: -1 })
        .limit(50);
    }
    const userMap = await serializeUsers(
      Array.from(new Set(recentMessages.map((m: any) => m.authorId))),
    );
    res.json(
      recentMessages.map((m: any) => {
        const u = userMap.get(m.authorId);
        const actorName = u?.name ?? "Someone";
        const snippet = m.content.length > 140
          ? `${m.content.slice(0, 140)}…`
          : m.content;
        return {
          id: `msg-${m.id}`,
          kind: "message",
          title: `${actorName} sent a message`,
          subtitle: snippet,
          actorId: m.authorId,
          actorName,
          conversationId: m.conversationId,
          createdAt: m.createdAt.toISOString(),
        };
      }),
    );
  },
);

router.get(
  "/admin/live",
  requireAuth,
  requireAdmin,
  async (_req, res): Promise<void> => {
    const onlineIds = getOnlineUserIds();
    const calls = getActiveCalls();
    
    const userIds = new Set([...onlineIds]);
    calls.forEach(c => {
      userIds.add(c.callerId);
      userIds.add(c.calleeId);
    });

    const userMap = await serializeUsers(Array.from(userIds));
    
    res.json({
      onlineUsers: onlineIds.map(id => userMap.get(id)).filter(Boolean),
      activeCalls: calls.map(c => ({
        ...c,
        caller: userMap.get(c.callerId),
        callee: userMap.get(c.calleeId),
      })),
    });
  },
);

export default router;
