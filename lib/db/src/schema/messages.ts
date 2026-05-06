import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  primaryKey,
  index,
  jsonb,
} from "drizzle-orm/pg-core";

export interface MessageAttachmentData {
  name: string;
  url: string;
  size: number;
  mimeType: string;
}
import { conversationsTable } from "./conversations";
import { usersTable } from "./users";

export const messagesTable = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    authorId: integer("author_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    attachments: jsonb("attachments")
      .$type<MessageAttachmentData[]>()
      .notNull()
      .default([]),
    replyToId: integer("reply_to_id"),
    mentionsEveryone: boolean("mentions_everyone").notNull().default(false),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    conversationIdx: index("messages_conversation_id_idx").on(t.conversationId),
    createdIdx: index("messages_conversation_created_idx").on(
      t.conversationId,
      t.createdAt,
    ),
  }),
);

export const messageMentionsTable = pgTable(
  "message_mentions",
  {
    messageId: integer("message_id")
      .notNull()
      .references(() => messagesTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.userId] }),
  }),
);

export const messageReadsTable = pgTable(
  "message_reads",
  {
    messageId: integer("message_id")
      .notNull()
      .references(() => messagesTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.userId] }),
  }),
);

export type Message = typeof messagesTable.$inferSelect;
export type InsertMessage = typeof messagesTable.$inferInsert;
export type MessageMention = typeof messageMentionsTable.$inferSelect;
export type MessageRead = typeof messageReadsTable.$inferSelect;
