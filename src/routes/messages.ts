import { Router, type IRouter } from "express";
import {
  db,
  messagesTable,
  messageMentionsTable,
  conversationMembersTable,
  conversationsTable,
  notificationsTable,
  usersTable,
  UserModel,
  ConversationModel,
  ConversationMemberModel,
  MessageModel,
  NotificationModel,
} from "@workspace/db";
import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import {
  ListMessagesQueryParams,
  SendMessageBody,
  EditMessageBody,
  SearchMessagesQueryParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import {
  enrichMessages,
  getRecentMessages,
  isConversationMember,
  serializeMessage,
  getConversationMemberIds,
} from "../lib/serializers";
import { emitToConversation, emitToUsers, emitAdminActivity } from "../lib/realtime";

const router: IRouter = Router();

router.get(
  "/conversations/:id/messages",
  requireAuth,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw ?? "", 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const me = req.user!.id;
    const isAdmin = req.user!.role === "admin";
    if (!isAdmin && !(await isConversationMember(id, me))) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const parsed = ListMessagesQueryParams.safeParse(req.query);
    const limit = parsed.success ? (parsed.data.limit ?? 50) : 50;
    const before = parsed.success ? parsed.data.before : undefined;
    const list = await getRecentMessages(id, before, limit);
    res.json(list);
  },
);

router.post(
  "/conversations/:id/messages",
  requireAuth,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw ?? "", 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const me = req.user!.id;
    if (!(await isConversationMember(id, me))) {
      res.status(403).json({ error: "Not a member of this conversation" });
      return;
    }
    const parsed = SendMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }
    const { content, replyToId, mentions, mentionsEveryone, attachments } = parsed.data;
    const cleanAttachments = attachments ?? [];
    if (!content.trim() && cleanAttachments.length === 0) {
      res.status(400).json({ error: "Empty message" });
      return;
    }
    if (replyToId != null) {
      const reply = await MessageModel.findOne({ id: replyToId });
      if (!reply || reply.conversationId !== id) {
        res.status(400).json({ error: "Invalid replyToId" });
        return;
      }
    }
    // Save message to MongoDB
    const m = await MessageModel.create({
      conversationId: id,
      authorId: me,
      content: content.trim(),
      attachments: cleanAttachments,
      replyToId: replyToId ?? undefined,
      mentionsEveryone: mentionsEveryone ?? false,
    });
    // Get all member IDs
    const memberIds = await getConversationMemberIds(id);
    // Update conversation updatedAt and sender's lastRead in MongoDB
    await ConversationModel.updateOne({ id }, { $set: { updatedAt: new Date() } });
    await ConversationMemberModel.updateOne(
      { conversationId: id, userId: me },
      { $set: { lastReadMessageId: m.id } },
    );
    const enriched = await serializeMessage(m.id);
    if (!enriched) {
      res.status(500).json({ error: "Failed to load message" });
      return;
    }
    emitToConversation(id, "message:new", { message: enriched });
    emitToUsers(memberIds, "message:new", { message: enriched });
    
    // Notify admins of live activity
    emitAdminActivity({
      id: `msg-${enriched.id}`,
      kind: "message",
      title: `${enriched.author.name} sent a message`,
      subtitle: enriched.content.slice(0, 140),
      actorId: enriched.authorId,
      actorName: enriched.author.name,
      conversationId: enriched.conversationId,
      createdAt: enriched.createdAt,
    });
    // Notifications for mentions
    const recipients = memberIds.filter((uid) => uid !== me);
    const validMentions = (mentions ?? []).filter((uid: number) => memberIds.includes(uid));
    const targetUserIds: number[] =
      mentionsEveryone === true
        ? recipients
        : Array.from(new Set(validMentions.filter((uid) => uid !== me)));
    if (targetUserIds.length > 0) {
      try {
        const conv = await ConversationModel.findOne({ id });
        const convName = conv?.kind === "group" ? (conv.name ?? "Group chat") : enriched.author.name;
        // Use save() individually instead of insertMany to trigger pre-save hooks (auto-increment id)
        for (const uid of targetUserIds) {
          const n = new NotificationModel({
            userId: uid,
            kind: "mention",
            title: `${enriched.author.name} mentioned you in ${convName}`,
            body: enriched.content.slice(0, 280),
            conversationId: id,
            messageId: enriched.id,
          });
          await n.save();
          emitToUsers([n.userId], "notification:new", {
            notification: {
              id: n.id, kind: n.kind, title: n.title, body: n.body,
              conversationId: n.conversationId, messageId: n.messageId,
              readAt: n.readAt ? n.readAt.toISOString() : null,
              createdAt: n.createdAt.toISOString(),
            },
          });
        }
      } catch (notifErr) {
        // Notification failure should not prevent message delivery
        console.error("Failed to create notification:", notifErr);
      }
    }
    res.status(201).json(enriched);
  },
);

router.patch(
  "/messages/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw ?? "", 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = EditMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }
    const me = req.user!.id;
    const m = await MessageModel.findOne({ id });
    if (!m) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    if (m.authorId !== me) {
      res.status(403).json({ error: "Cannot edit another user's message" });
      return;
    }
    if (m.deletedAt) {
      res.status(400).json({ error: "Cannot edit a deleted message" });
      return;
    }
    await MessageModel.updateOne({ id }, { $set: { content: parsed.data.content.trim(), editedAt: new Date() } });
    const enriched = await serializeMessage(id);
    if (!enriched) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    emitToConversation(m.conversationId, "message:edit", { message: enriched });
    res.json(enriched);
  },
);

router.delete(
  "/messages/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw ?? "", 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const me = req.user!.id;
    const isAdmin = req.user!.role === "admin";
    const m = await MessageModel.findOne({ id });
    if (!m) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    if (m.authorId !== me && !isAdmin) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    await MessageModel.updateOne({ id }, { $set: { deletedAt: new Date(), content: "" } });
    emitToConversation(m.conversationId, "message:delete", { id, conversationId: m.conversationId });
    res.status(204).send();
  },
);

router.get(
  "/messages/search",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = SearchMessagesQueryParams.safeParse(req.query);
    if (!parsed.success || !parsed.data.q.trim()) {
      res.json([]);
      return;
    }
    const me = req.user!.id;
    const isAdmin = req.user!.role === "admin";
    const memberConvIds: number[] | null = isAdmin
      ? null
      : (
        await db
          .select({
            conversationId: conversationMembersTable.conversationId,
          })
          .from(conversationMembersTable)
          .where(eq(conversationMembersTable.userId, me))
      ).map((r: { conversationId: number }) => r.conversationId);

    if (memberConvIds && memberConvIds.length === 0) {
      res.json([]);
      return;
    }

    const baseQuery = db
      .select()
      .from(messagesTable)
      .where(
        memberConvIds === null
          ? and(
            ilike(messagesTable.content, `%${parsed.data.q}%`),
            sql`${messagesTable.deletedAt} IS NULL`,
          )
          : and(
            ilike(messagesTable.content, `%${parsed.data.q}%`),
            inArray(messagesTable.conversationId, memberConvIds),
            sql`${messagesTable.deletedAt} IS NULL`,
          ),
      )
      .orderBy(desc(messagesTable.id))
      .limit(50);
    const rows = await baseQuery;
    const enriched = await enrichMessages(rows);

    const convIds: number[] = Array.from(new Set(rows.map((r: any) => r.conversationId)));
    const convs: (typeof conversationsTable.$inferSelect)[] =
      convIds.length === 0
        ? []
        : await db
          .select()
          .from(conversationsTable)
          .where(inArray(conversationsTable.id, convIds));
    const directConvIds = convs.filter((c) => c.kind === "direct").map((c) => c.id);
    const directMembers: (typeof conversationMembersTable.$inferSelect)[] =
      directConvIds.length === 0
        ? []
        : await db
          .select()
          .from(conversationMembersTable)
          .where(
            inArray(conversationMembersTable.conversationId, directConvIds),
          );
    const directOtherIds = new Set<number>();
    for (const dm of directMembers) {
      if (dm.userId !== me) directOtherIds.add(dm.userId);
    }
    const otherUsersList =
      directOtherIds.size === 0
        ? []
        : await db
          .select()
          .from(usersTable)
          .where(inArray(usersTable.id, Array.from(directOtherIds)));
    const otherUserMap = new Map<number, (typeof otherUsersList)[number]>();
    for (const u of otherUsersList) otherUserMap.set(u.id, u);

    const convInfo = new Map<
      number,
      { kind: string; name: string }
    >();
    for (const c of convs) {
      let name = c.name ?? "";
      if (c.kind === "direct") {
        const otherIds = directMembers
          .filter((dm) => dm.conversationId === c.id && dm.userId !== me)
          .map((dm) => dm.userId);
        const other = otherIds[0];
        if (other != null) {
          const u = otherUserMap.get(other);
          name = u?.name ?? "Direct message";
        }
      }
      convInfo.set(c.id, { kind: c.kind, name: name || "Conversation" });
    }

    const conversationsById = new Map(convs.map((c) => [c.id, c]));
    const memberMap = new Map<number, typeof directMembers>();
    for (const dm of directMembers) {
      const arr = memberMap.get(dm.conversationId) ?? [];
      arr.push(dm);
      memberMap.set(dm.conversationId, arr);
    }
    const allMemberRows: (typeof conversationMembersTable.$inferSelect)[] =
      convIds.length === 0
        ? []
        : await db
          .select()
          .from(conversationMembersTable)
          .where(
            inArray(conversationMembersTable.conversationId, convIds),
          );
    const allMembersByConv = new Map<number, typeof allMemberRows>();
    for (const m of allMemberRows) {
      const arr = allMembersByConv.get(m.conversationId) ?? [];
      arr.push(m);
      allMembersByConv.set(m.conversationId, arr);
    }
    const allMemberUserIds = Array.from(
      new Set(allMemberRows.map((m) => m.userId)),
    );
    const allUsers: (typeof usersTable.$inferSelect)[] =
      allMemberUserIds.length === 0
        ? []
        : await db
          .select()
          .from(usersTable)
          .where(inArray(usersTable.id, allMemberUserIds));
    const allUsersById = new Map(allUsers.map((u) => [u.id, u]));

    res.json(
      enriched.map((m: any) => {
        const c = conversationsById.get(m.conversationId) as any;
        const members = (allMembersByConv.get(m.conversationId) ?? []).map(
          (mem: any) => {
            const u = allUsersById.get(mem.userId);
            return {
              userId: mem.userId,
              isAdmin: mem.isAdmin,
              user: u
                ? {
                  id: u.id,
                  email: u.email,
                  name: u.name,
                  role: u.role,
                  title: u.title,
                  avatarColor: u.avatarColor,
                  status: u.status,
                  lastSeenAt: u.lastSeenAt
                    ? u.lastSeenAt.toISOString()
                    : null,
                  createdAt: u.createdAt.toISOString(),
                }
                : null,
            };
          },
        );
        return {
          message: m,
          conversation: {
            id: c?.id ?? m.conversationId,
            kind: c?.kind ?? "group",
            name: c?.name ?? null,
            createdAt: c?.createdAt.toISOString() ?? new Date().toISOString(),
            members,
            lastMessage: null,
            unreadCount: 0,
            pinned: false,
            muted: false,
          },
        };
      }),
    );
  },
);

export default router;
