import {
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
  integer,
  boolean,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const conversationsTable = pgTable(
  "conversations",
  {
    id: serial("id").primaryKey(),
    kind: varchar("kind", { length: 16 }).notNull(),
    name: text("name"),
    iconEmoji: text("icon_emoji"),
    directKey: text("direct_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    directKeyIdx: uniqueIndex("conversations_direct_key_unique").on(t.directKey),
  }),
);

export const conversationMembersTable = pgTable(
  "conversation_members",
  {
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    isAdmin: boolean("is_admin").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
    muted: boolean("muted").notNull().default(false),
    lastReadMessageId: integer("last_read_message_id").default(0).notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.userId] }),
  }),
);

export type Conversation = typeof conversationsTable.$inferSelect;
export type InsertConversation = typeof conversationsTable.$inferInsert;
export type ConversationMember = typeof conversationMembersTable.$inferSelect;
export type InsertConversationMember =
  typeof conversationMembersTable.$inferInsert;
