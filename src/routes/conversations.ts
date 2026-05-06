import { Router, type IRouter } from "express";
import {
  db,
  conversationsTable,
  conversationMembersTable,
  usersTable,
  messagesTable,
  messageReadsTable,
  UserModel,
  ConversationModel,
  ConversationMemberModel,
  MessageModel,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  CreateDirectConversationBody,
  CreateGroupConversationBody,
  UpdateConversationBody,
  AddConversationMemberBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import {
  getConversationMemberIds,
  isConversationMember,
  serializeConversation,
  serializeConversations,
} from "../lib/serializers";
import { emitToUsers, emitToConversation } from "../lib/realtime";

const router: IRouter = Router();

function directKeyFor(a: number, b: number): string {
  const [x, y] = a < b ? [a, b] : [b, a];
  return `direct:${x}:${y}`;
}

router.get(
  "/conversations",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.user!.id;
    let ids: number[] = [];

    // Try MongoDB
    try {
      const memberships = await ConversationMemberModel.find({ userId });
      ids = memberships.map((m) => m.conversationId);
    } catch (err) {}

    // Fallback to Drizzle
    if (ids.length === 0 && db) {
      const memberships = await db
        .select({ conversationId: conversationMembersTable.conversationId })
        .from(conversationMembersTable)
        .where(eq(conversationMembersTable.userId, userId));
      ids = memberships.map((m: { conversationId: number }) => m.conversationId);
    }

    if (ids.length === 0) {
      res.json([]);
      return;
    }

    const list = await serializeConversations(ids, userId);
    list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const at = a.lastMessage?.createdAt ?? a.createdAt;
      const bt = b.lastMessage?.createdAt ?? b.createdAt;
      return bt.localeCompare(at);
    });
    res.json(list);
  },
);

router.post(
  "/conversations/direct",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = CreateDirectConversationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }
    const me = req.user!.id;
    const other = parsed.data.userId;
    if (me === other) {
      res.status(400).json({ error: "Cannot create a chat with yourself" });
      return;
    }

    // Check if other user exists
    let otherUser: any = null;
    try {
      otherUser = await UserModel.findOne({ id: other });
    } catch (err) {}
    
    if (!otherUser && db) {
      const [dbUser] = await db.select().from(usersTable).where(eq(usersTable.id, other));
      otherUser = dbUser;
    }

    if (!otherUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const key = directKeyFor(me, other);
    let convId: number | undefined;

    // Try MongoDB
    try {
      let existing = await ConversationModel.findOne({ directKey: key });
      if (existing) {
        convId = existing.id;
        // Ensure both users are members (idempotent upsert)
        await ConversationMemberModel.updateOne(
          { conversationId: convId, userId: me },
          { $setOnInsert: { conversationId: convId, userId: me, isAdmin: false } },
          { upsert: true },
        );
        await ConversationMemberModel.updateOne(
          { conversationId: convId, userId: other },
          { $setOnInsert: { conversationId: convId, userId: other, isAdmin: false } },
          { upsert: true },
        );
      } else {
        const c = await ConversationModel.create({ kind: "direct", directKey: key });
        convId = c.id;
        await ConversationMemberModel.insertMany([
          { conversationId: convId, userId: me, isAdmin: false },
          { conversationId: convId, userId: other, isAdmin: false },
        ]);
        
        // Sync to Drizzle if available
        if (db) {
          try {
            await db.insert(conversationsTable).values({ id: convId, kind: "direct", directKey: key });
            await db.insert(conversationMembersTable).values([
              { conversationId: convId, userId: me, isAdmin: false },
              { conversationId: convId, userId: other, isAdmin: false },
            ]);
          } catch (err) {}
        }
      }
    } catch (err) {
      // Fallback to Drizzle only if MongoDB failed
      if (!convId && db) {
        const [existingD] = await db.select().from(conversationsTable).where(eq(conversationsTable.directKey, key));
        if (existingD) {
          convId = existingD.id;
        } else {
          const [c] = await db.insert(conversationsTable).values({ kind: "direct", directKey: key }).returning();
          if (c) {
            convId = c.id;
            await db.insert(conversationMembersTable).values([
              { conversationId: convId, userId: me, isAdmin: false },
              { conversationId: convId, userId: other, isAdmin: false },
            ]);
          }
        }
      }
    }

    if (!convId) {
      res.status(500).json({ error: "Failed to create conversation" });
      return;
    }

    const out = await serializeConversation(convId, me);
    if (!out) {
      res.status(500).json({ error: "Failed to load conversation" });
      return;
    }
    emitToUsers([me, other], "conversation:update", { conversation: out });
    res.json(out);
  },
);

router.post(
  "/conversations/group",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = CreateGroupConversationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }
    const me = req.user!.id;
    const memberIds = Array.from(new Set([me, ...parsed.data.memberIds]));
    if (memberIds.length < 2) {
      res.status(400).json({ error: "Group requires at least 2 members" });
      return;
    }
    // Validate members exist in MongoDB
    const foundMongo = await UserModel.find({ id: { $in: memberIds } }, { id: 1 });
    const foundIds = foundMongo.map((u: any) => u.id);
    if (foundIds.length !== memberIds.length) {
      res.status(400).json({ error: "Invalid member id" });
      return;
    }
    const c = await ConversationModel.create({ kind: "group", name: parsed.data.name });
    await ConversationMemberModel.insertMany(
      memberIds.map((uid) => ({ conversationId: c.id, userId: uid, isAdmin: uid === me })),
    );
    const out = await serializeConversation(c.id, me);
    if (!out) {
      res.status(500).json({ error: "Failed to load conversation" });
      return;
    }
    emitToUsers(memberIds, "conversation:update", { conversation: out });
    res.status(201).json(out);
  },
);

router.get(
  "/conversations/:id",
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
    const isMember = await isConversationMember(id, me);
    process.stdout.write(`[Conv Debug] GET /conversations/${id} user=${me} isAdmin=${isAdmin} isMember=${isMember}\n`);
    if (!isAdmin && !isMember) {
      res.status(404).json({ error: "Conversation not found (not a member)" });
      return;
    }
    const out = await serializeConversation(id, me);
    if (!out) {
      res.status(404).json({ error: "Conversation not found (serialize failed)" });
      return;
    }
    res.json(out);
  },
);

router.patch(
  "/conversations/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw ?? "", 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = UpdateConversationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }
    const me = req.user!.id;
    const membership = await ConversationMemberModel.findOne({ conversationId: id, userId: me });
    if (!membership) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const memberPatch: any = {};
    if (parsed.data.pinned != null) memberPatch.pinned = parsed.data.pinned;
    if (parsed.data.muted != null) memberPatch.muted = parsed.data.muted;
    if (Object.keys(memberPatch).length > 0) {
      await ConversationMemberModel.updateOne({ conversationId: id, userId: me }, { $set: memberPatch });
    }
    const wantsName = parsed.data.name != null;
    const wantsIcon = parsed.data.iconEmoji !== undefined;
    if (wantsName || wantsIcon) {
      const conv = await ConversationModel.findOne({ id });
      if (!conv) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      if (conv.kind !== "group") {
        res.status(400).json({ error: "Can only edit group conversations" });
        return;
      }
      if (!membership.isAdmin) {
        res.status(403).json({ error: "Only group admins can edit" });
        return;
      }
      const convPatch: any = {};
      if (wantsName) convPatch.name = parsed.data.name;
      if (wantsIcon) convPatch.iconEmoji = parsed.data.iconEmoji;
      await ConversationModel.updateOne({ id }, { $set: convPatch });
    }
    const out = await serializeConversation(id, me);
    if (!out) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const memberIds = await getConversationMemberIds(id);
    emitToUsers(memberIds, "conversation:update", { conversation: out });
    res.json(out);
  },
);

router.post(
  "/conversations/:id/leave",
  requireAuth,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw ?? "", 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const me = req.user!.id;
    const conv = await ConversationModel.findOne({ id });
    if (!conv || conv.kind !== "group") {
      res.status(400).json({ error: "Cannot leave this conversation" });
      return;
    }
    const previousMemberIds = await getConversationMemberIds(id);
    await ConversationMemberModel.deleteOne({ conversationId: id, userId: me });
    const out = await serializeConversation(id, null);
    if (out) emitToUsers(previousMemberIds, "conversation:update", { conversation: out });
    res.status(204).send();
  },
);

router.post(
  "/conversations/:id/read",
  requireAuth,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw ?? "", 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const me = req.user!.id;
    // Find the latest message in the conversation
    const latestMsg = await MessageModel.findOne({ conversationId: id }).sort({ id: -1 });
    const upTo = latestMsg?.id ?? 0;
    // Update the member's lastReadMessageId in MongoDB
    await ConversationMemberModel.updateOne(
      { conversationId: id, userId: me },
      { $set: { lastReadMessageId: upTo } },
    );
    emitToConversation(id, "message:read", { conversationId: id, userId: me, messageId: upTo });
    res.status(204).send();
  },
);

router.post(
  "/conversations/:id/members",
  requireAuth,
  async (req, res): Promise<void> => {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = parseInt(raw ?? "", 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = AddConversationMemberBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }
    const me = req.user!.id;
    const conv = await ConversationModel.findOne({ id });
    if (!conv || conv.kind !== "group") {
      res.status(400).json({ error: "Can only add members to groups" });
      return;
    }
    const membership = await ConversationMemberModel.findOne({ conversationId: id, userId: me });
    if (!membership) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    if (!membership.isAdmin && req.user!.role !== "admin") {
      res.status(403).json({ error: "Only group admins can add members" });
      return;
    }
    // upsert – ignore if already member
    await ConversationMemberModel.updateOne(
      { conversationId: id, userId: parsed.data.userId },
      { $setOnInsert: { conversationId: id, userId: parsed.data.userId, isAdmin: false } },
      { upsert: true },
    );
    const out = await serializeConversation(id, me);
    if (!out) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const memberIds = await getConversationMemberIds(id);
    emitToUsers(memberIds, "conversation:update", { conversation: out });
    res.json(out);
  },
);

router.delete(
  "/conversations/:id/members/:userId",
  requireAuth,
  async (req, res): Promise<void> => {
    const idRaw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const userIdRaw = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    const id = parseInt(idRaw ?? "", 10);
    const userId = parseInt(userIdRaw ?? "", 10);
    if (Number.isNaN(id) || Number.isNaN(userId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const me = req.user!.id;
    const conv = await ConversationModel.findOne({ id });
    if (!conv || conv.kind !== "group") {
      res.status(400).json({ error: "Can only remove from groups" });
      return;
    }
    const membership = await ConversationMemberModel.findOne({ conversationId: id, userId: me });
    if (!membership && req.user!.role !== "admin") {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    if (userId !== me && !membership?.isAdmin && req.user!.role !== "admin") {
      res.status(403).json({ error: "Only group admins can remove members" });
      return;
    }
    const previousMemberIds = await getConversationMemberIds(id);
    await ConversationMemberModel.deleteOne({ conversationId: id, userId });
    const out = await serializeConversation(id, me);
    if (!out) {
      res.json({
        id, kind: conv.kind, name: conv.name ?? null,
        createdAt: conv.createdAt.toISOString(),
        members: [], lastMessage: null, unreadCount: 0, pinned: false, muted: false,
      });
      return;
    }
    emitToUsers(previousMemberIds, "conversation:update", { conversation: out });
    res.json(out);
  },
);

router.post(
  "/conversations/:id/admins/:userId",
  requireAuth,
  async (req, res): Promise<void> => {
    const idRaw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const userIdRaw = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    const id = parseInt(idRaw ?? "", 10);
    const userId = parseInt(userIdRaw ?? "", 10);
    if (Number.isNaN(id) || Number.isNaN(userId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const me = req.user!.id;
    const membership = await ConversationMemberModel.findOne({ conversationId: id, userId: me });
    if (!membership || (!membership.isAdmin && req.user!.role !== "admin")) {
      res.status(403).json({ error: "Only group admins can promote" });
      return;
    }
    await ConversationMemberModel.updateOne(
      { conversationId: id, userId },
      { $set: { isAdmin: true } },
    );
    const out = await serializeConversation(id, me);
    if (!out) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const memberIds = await getConversationMemberIds(id);
    emitToUsers(memberIds, "conversation:update", { conversation: out });
    res.json(out);
  },
);

export default router;
