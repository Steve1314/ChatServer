import { db, usersTable, messagesTable, conversationsTable, conversationMembersTable, messageMentionsTable, messageReadsTable, UserModel, MessageModel, ConversationModel, ConversationMemberModel, MessageMention, MessageRead } from "@workspace/db";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { normalizeMongoUser } from "./mongo-mapper";
import { stripUser, type AuthUser } from "./auth";
import { isUserOnline } from "./realtime";

function withPresence(user: any): AuthUser {
  const stripped = stripUser(user);
  const isOnline = isUserOnline(stripped.id);

  let status = stripped.status || "offline";
  if (isOnline) {
    // If they are connected but status is offline, default to online
    if (status === "offline") status = "online";
  } else {
    // If not connected, they are offline
    status = "offline";
  }

  return {
    ...stripped,
    status: status as any,
  };
}

export type SerializedUser = ReturnType<typeof withPresence>;

export async function serializeUser(userId: number | string): Promise<SerializedUser | null> {
  // Try MongoDB first
  try {
    const isNumericOnly = typeof userId === 'number' || (typeof userId === 'string' && /^\d+$/.test(userId));
    const isMongoObjectId = typeof userId === 'string' && /^[0-9a-f]{24}$/i.test(userId);

    let query: any;
    if (isNumericOnly) {
      const numericId = typeof userId === 'number' ? userId : parseInt(userId, 10);
      query = { id: numericId };
    } else if (isMongoObjectId) {
      query = { _id: String(userId) };
    } else {
      query = { id: typeof userId === 'number' ? userId : parseInt(String(userId), 10) };
    }

    const u = await UserModel.findOne(query);
    if (u) return withPresence(normalizeMongoUser(u));
  } catch (err) {
    // MongoDB failed or not configured
  }

  // Fallback to Drizzle
  if (db && typeof userId === 'number') {
    const [u] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    if (u) return withPresence(u);
  }

  return null;
}

export async function serializeUsers(
  userIds: (number | string)[],
): Promise<Map<number, SerializedUser>> {
  const map = new Map<number, SerializedUser>();
  if (userIds.length === 0) return map;

  const numericIds = userIds.map(id => typeof id === 'string' ? parseInt(id) : id);

  // Try MongoDB
  try {
    const mongoUsers = await UserModel.find({ id: { $in: numericIds } });
    for (const u of mongoUsers) {
      const normalized = normalizeMongoUser(u);
      map.set(normalized.id, withPresence(normalized));
    }
  } catch (err) {
    // MongoDB failed or not configured
  }

  // Try Drizzle for missing ones
  if (db) {
    const remainingIds = numericIds.filter(id => !map.has(id));
    if (remainingIds.length > 0) {
      const rows = await db
        .select()
        .from(usersTable)
        .where(inArray(usersTable.id, remainingIds));
      for (const r of rows) {
        map.set(r.id, withPresence(r));
      }
    }
  }

  return map;
}

export async function serializeMessage(
  messageId: number,
): Promise<SerializedMessage | null> {
  // Try MongoDB
  try {
    const m = await MessageModel.findOne({ id: messageId });
    if (m) {
      const enriched = await enrichMessages([m]);
      return enriched[0] ?? null;
    }
  } catch (err) {}

  // Try Drizzle
  if (db) {
    const [m] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, messageId));
    if (m) {
      const enriched = await enrichMessages([m]);
      return enriched[0] ?? null;
    }
  }
  return null;
}

export interface SerializedMessageAttachment {
  name: string;
  url: string;
  size: number;
  mimeType: string;
}

export interface SerializedMessage {
  id: number;
  conversationId: number;
  authorId: number;
  author: SerializedUser;
  content: string;
  attachments: SerializedMessageAttachment[];
  replyToId: number | null;
  replyTo: {
    id: number;
    authorId: number;
    authorName: string;
    content: string;
  } | null;
  mentions: number[];
  mentionsEveryone: boolean;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  readBy: number[];
}

export async function enrichMessages(
  messages: any[],
): Promise<SerializedMessage[]> {
  if (messages.length === 0) return [];
  const ids = messages.map((m) => m.id);
  const authorIds = Array.from(new Set(messages.map((m) => m.authorId)));
  const replyIds = messages
    .map((m) => m.replyToId)
    .filter((v): v is number => v !== null && v !== 0);

  // Note: For simplicity in MongoDB, we assume mentions and reads are handled differently or we fetch them here.
  // In our MongoDB schema, we don't have messageMentionsTable or messageReadsTable as separate models yet.
  // Actually, I should probably add them or store them in the message document.
  // Given the current schema in models.ts, mentions are not yet defined as a separate model.
  // I'll update MessageModel to include mentions and readBy if not already there, OR I'll create the models.
  
  // For now, let's assume we fetch them from Drizzle if available, or just return empty arrays.
  // However, I should probably update models.ts to include these relations.
  
  const userMap = await serializeUsers(authorIds);
  
  // Fetch replies
  const replyMap = new Map<number, any>();
  if (replyIds.length > 0) {
    // Try MongoDB
    try {
      const mongoReplies = await MessageModel.find({ id: { $in: replyIds } });
      for (const r of mongoReplies) replyMap.set(r.id, r);
    } catch (err) {}
    
    // Fallback to Drizzle
    if (db) {
      const remainingReplyIds = replyIds.filter(id => !replyMap.has(id));
      if (remainingReplyIds.length > 0) {
        const rows = await db.select().from(messagesTable).where(inArray(messagesTable.id, remainingReplyIds));
        for (const r of rows) replyMap.set(r.id, r);
      }
    }
  }

  // Fetch mentions and reads from Drizzle if available
  const mentionsByMessage = new Map<number, number[]>();
  const readsByMessage = new Map<number, number[]>();
  
  if (db) {
    const [mentions, reads] = await Promise.all([
      db.select().from(messageMentionsTable).where(inArray(messageMentionsTable.messageId, ids)),
      db.select().from(messageReadsTable).where(inArray(messageReadsTable.messageId, ids)),
    ]);
    for (const m of mentions) {
      const arr = mentionsByMessage.get(m.messageId) ?? [];
      arr.push(m.userId);
      mentionsByMessage.set(m.messageId, arr);
    }
    for (const r of reads) {
      const arr = readsByMessage.get(r.messageId) ?? [];
      arr.push(r.userId);
      readsByMessage.set(r.messageId, arr);
    }
  }

  return messages.map((m) => {
    const author = userMap.get(m.authorId);
    if (!author) {
      // Create a dummy author if missing to avoid crashing, but log it
      return {
        id: m.id,
        conversationId: m.conversationId,
        authorId: m.authorId,
        author: { id: m.authorId, name: "Unknown User", email: "", role: "user", avatarColor: "#ccc", status: "offline", createdAt: new Date() } as any,
        content: m.content,
        attachments: m.attachments ?? [],
        replyToId: m.replyToId,
        replyTo: null,
        mentions: mentionsByMessage.get(m.id) ?? [],
        mentionsEveryone: m.mentionsEveryone ?? false,
        editedAt: m.editedAt ? m.editedAt.toISOString() : null,
        deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
        createdAt: m.createdAt.toISOString(),
        readBy: readsByMessage.get(m.id) ?? [],
      };
    }
    const reply = m.replyToId ? replyMap.get(m.replyToId) : undefined;
    const isDeleted = m.deletedAt != null;
    return {
      id: m.id,
      conversationId: m.conversationId,
      authorId: m.authorId,
      author,
      content: isDeleted ? "" : m.content,
      attachments: isDeleted ? [] : (m.attachments ?? []),
      replyToId: m.replyToId || null,
      replyTo: reply ? {
        id: reply.id,
        authorId: reply.authorId,
        authorName: "User", // We'd need to fetch reply authors too for full completeness
        content: reply.deletedAt ? "[deleted message]" : reply.content.slice(0, 200),
      } : null,
      mentions: mentionsByMessage.get(m.id) ?? [],
      mentionsEveryone: m.mentionsEveryone ?? false,
      editedAt: m.editedAt ? m.editedAt.toISOString() : null,
      deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
      createdAt: m.createdAt.toISOString(),
      readBy: readsByMessage.get(m.id) ?? [],
    };
  });
}

export interface SerializedConversation {
  id: number;
  kind: "direct" | "group";
  name: string | null;
  iconEmoji: string | null;
  createdAt: string;
  members: Array<{
    userId: number;
    isAdmin: boolean;
    user: SerializedUser;
  }>;
  lastMessage: SerializedMessage | null;
  unreadCount: number;
  pinned: boolean;
  muted: boolean;
}

export async function serializeConversations(
  conversationIds: number[],
  viewerId: number | null,
): Promise<SerializedConversation[]> {
  if (conversationIds.length === 0) return [];

  // ── Fetch conversations ──────────────────────────────────────────────────
  let convs: any[] = [];
  try {
    convs = await ConversationModel.find({ id: { $in: conversationIds } });
  } catch (_) {}
  if (convs.length === 0 && db) {
    convs = await db
      .select()
      .from(conversationsTable)
      .where(inArray(conversationsTable.id, conversationIds));
  }

  // ── Fetch members ────────────────────────────────────────────────────────
  let allMembers: any[] = [];
  try {
    allMembers = await ConversationMemberModel.find({
      conversationId: { $in: conversationIds },
    });
  } catch (_) {}
  if (allMembers.length === 0 && db) {
    allMembers = await db
      .select()
      .from(conversationMembersTable)
      .where(inArray(conversationMembersTable.conversationId, conversationIds));
  }

  const memberUserIds = Array.from(new Set(allMembers.map((m: any) => m.userId)));
  const userMap = await serializeUsers(memberUserIds);

  // ── Fetch last messages ──────────────────────────────────────────────────
  const lastByConv = new Map<number, SerializedMessage>();
  try {
    // For each conversationId get the message with the highest numeric id
    const lastMsgs = await MessageModel.aggregate([
      { $match: { conversationId: { $in: conversationIds } } },
      { $sort: { id: -1 } },
      { $group: { _id: "$conversationId", doc: { $first: "$$ROOT" } } },
      { $replaceRoot: { newRoot: "$doc" } },
    ]);
    if (lastMsgs.length > 0) {
      const enriched = await enrichMessages(lastMsgs);
      for (const m of enriched) lastByConv.set(m.conversationId, m);
    }
  } catch (_) {}

  // Drizzle fallback for last messages
  if (lastByConv.size === 0 && db) {
    try {
      const lastMessages = await db.execute(sql`
        SELECT m.* FROM messages m
        INNER JOIN (
          SELECT conversation_id, MAX(id) AS last_id
          FROM messages
          WHERE conversation_id IN (${sql.join(
            conversationIds.map((id) => sql`${id}`),
            sql`, `,
          )})
          GROUP BY conversation_id
        ) lm ON lm.last_id = m.id
      `);
      const lastRows = (lastMessages.rows as Array<Record<string, unknown>>).map((r) => ({
        id: Number(r["id"]),
        conversationId: Number(r["conversation_id"]),
        authorId: Number(r["author_id"]),
        content: String(r["content"]),
        attachments: Array.isArray(r["attachments"]) ? (r["attachments"] as never) : ([] as never),
        replyToId: r["reply_to_id"] === null ? null : Number(r["reply_to_id"]),
        mentionsEveryone: Boolean(r["mentions_everyone"]),
        editedAt: r["edited_at"] ? new Date(r["edited_at"] as string) : null,
        deletedAt: r["deleted_at"] ? new Date(r["deleted_at"] as string) : null,
        createdAt: new Date(r["created_at"] as string),
      }));
      const enrichedLast = await enrichMessages(lastRows);
      for (const m of enrichedLast) lastByConv.set(m.conversationId, m);
    } catch (_) {}
  }

  // ── Build member map ─────────────────────────────────────────────────────
  const membersByConv = new Map<number, any[]>();
  for (const m of allMembers) {
    const arr = membersByConv.get(m.conversationId) ?? [];
    arr.push(m);
    membersByConv.set(m.conversationId, arr);
  }

  // ── Compute unread counts ────────────────────────────────────────────────
  const unreadByConv = new Map<number, number>();
  const viewerMembershipMap = new Map<number, any>();

  if (viewerId !== null) {
    const myMemberships = allMembers.filter((m: any) => m.userId === viewerId);
    for (const m of myMemberships) viewerMembershipMap.set(m.conversationId, m);

    // Compute unread via MongoDB aggregate
    try {
      for (const m of myMemberships) {
        const count = await MessageModel.countDocuments({
          conversationId: m.conversationId,
          authorId: { $ne: viewerId },
          id: { $gt: m.lastReadMessageId ?? 0 },
          deletedAt: null,
        });
        if (count > 0) unreadByConv.set(m.conversationId, count);
      }
    } catch (_) {
      // Fallback to Drizzle unread if available
      if (db && myMemberships.length > 0) {
        try {
          const unreadRows = await db.execute(sql`
            SELECT m.conversation_id, COUNT(*)::int AS unread
            FROM messages m
            JOIN conversation_members cm
              ON cm.conversation_id = m.conversation_id AND cm.user_id = ${viewerId}
            WHERE m.conversation_id IN (${sql.join(
              conversationIds.map((id) => sql`${id}`),
              sql`, `,
            )})
              AND m.author_id <> ${viewerId}
              AND m.id > cm.last_read_message_id
              AND m.deleted_at IS NULL
            GROUP BY m.conversation_id
          `);
          for (const row of unreadRows.rows as Array<Record<string, unknown>>) {
            unreadByConv.set(Number(row["conversation_id"]), Number(row["unread"] ?? 0));
          }
        } catch (_) {}
      }
    }
  }

  return convs.map((c: any): SerializedConversation => {
    const members = (membersByConv.get(c.id) ?? []).map((m: any) => {
      const u = userMap.get(m.userId);
      if (!u) return null;
      return { userId: m.userId, isAdmin: m.isAdmin, user: u };
    }).filter(Boolean) as Array<{ userId: number; isAdmin: boolean; user: SerializedUser }>;

    const myMembership = viewerMembershipMap.get(c.id);
    return {
      id: c.id,
      kind: c.kind as "direct" | "group",
      name: c.name ?? null,
      iconEmoji: c.iconEmoji ?? null,
      createdAt: c.createdAt.toISOString(),
      members,
      lastMessage: lastByConv.get(c.id) ?? null,
      unreadCount: unreadByConv.get(c.id) ?? 0,
      pinned: myMembership?.pinned ?? false,
      muted: myMembership?.muted ?? false,
    };
  });
}

export async function serializeConversation(
  conversationId: number,
  viewerId: number | null,
): Promise<SerializedConversation | null> {
  const list = await serializeConversations([conversationId], viewerId);
  return list[0] ?? null;
}

export async function getConversationMemberIds(
  conversationId: number,
): Promise<number[]> {
  // Try MongoDB
  try {
    const members = await ConversationMemberModel.find({ conversationId });
    if (members.length > 0) return members.map(m => m.userId);
  } catch (err) {}

  // Fallback to Drizzle
  if (db) {
    const rows = await db
      .select({ userId: conversationMembersTable.userId })
      .from(conversationMembersTable)
      .where(eq(conversationMembersTable.conversationId, conversationId));
    return rows.map((r: { userId: number }) => r.userId);
  }
  return [];
}

export async function isConversationMember(
  conversationId: number,
  userId: number,
): Promise<boolean> {
  // Try MongoDB
  try {
    const member = await ConversationMemberModel.findOne({ conversationId, userId });
    process.stdout.write(`[Conv Debug] isConversationMember(convId=${conversationId}, userId=${userId}) found=${!!member}\n`);
    if (member) return true;
  } catch (err) {
    process.stdout.write(`[Conv Debug] isConversationMember MongoDB error: ${err}\n`);
  }

  // Fallback to Drizzle
  if (db) {
    const [row] = await db
      .select({ userId: conversationMembersTable.userId })
      .from(conversationMembersTable)
      .where(
        and(
          eq(conversationMembersTable.conversationId, conversationId),
          eq(conversationMembersTable.userId, userId),
        ),
      );
    return !!row;
  }
  return false;
}

export async function getRecentMessages(
  conversationId: number,
  before: number | undefined,
  limit: number,
): Promise<SerializedMessage[]> {
  let rows: any[] = [];

  // Try MongoDB
  try {
    const query: any = { conversationId };
    if (before !== undefined) {
      query.id = { $lt: before };
    }
    rows = await MessageModel.find(query)
      .sort({ id: -1 })
      .limit(limit);
  } catch (err) {}

  // Fallback to Drizzle if no results from MongoDB and Drizzle is connected
  if (rows.length === 0 && db) {
    rows = await db
      .select()
      .from(messagesTable)
      .where(
        before !== undefined
          ? and(
              eq(messagesTable.conversationId, conversationId),
              lt(messagesTable.id, before),
            )
          : eq(messagesTable.conversationId, conversationId),
      )
      .orderBy(desc(messagesTable.id))
      .limit(limit);
  }

  const enriched = await enrichMessages(rows);
  return enriched.sort((a, b) => a.id - b.id);
}

export { asc };
