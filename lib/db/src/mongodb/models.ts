import mongoose, { Schema, Document } from "mongoose";

// Counter Model for auto-incrementing numeric IDs
export interface ICounter {
  _id: string;
  seq: number;
}

const CounterSchema: Schema = new Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

export const CounterModel = mongoose.model<ICounter>("Counter", CounterSchema);

async function getNextSequence(name: string): Promise<number> {
  const counter = await CounterModel.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
}

// User Model
export interface IUser {
  id: number;
  email: string;
  name: string;
  passwordHash: string;
  role: "user" | "admin";
  title?: string;
  avatarColor: string;
  status: "online" | "offline" | "away" | "busy";
  lastSeenAt?: Date;
  createdAt: Date;
}

const UserSchema: Schema = new Schema({
  id: { type: Number, unique: true, index: true },
  email: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ["user", "admin"], default: "user", required: true },
  title: { type: String },
  avatarColor: { type: String, default: "#4f46e5", required: true },
  status: { type: String, enum: ["online", "offline", "away", "busy", "dnd", "brb"], default: "online", required: true },
  lastSeenAt: { type: Date },
  createdAt: { type: Date, default: Date.now, required: true },
});

UserSchema.pre("save", async function () {
  if (this.isNew && !(this as any).id) {
    (this as any).id = await getNextSequence("userId");
  }
});

export const UserModel = mongoose.model<IUser>("User", UserSchema);

// Conversation Model
export interface IConversation {
  id: number;
  kind: "direct" | "group";
  name?: string;
  iconEmoji?: string;
  directKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ConversationSchema: Schema = new Schema({
  id: { type: Number, unique: true, index: true },
  kind: { type: String, enum: ["direct", "group"], required: true },
  name: { type: String },
  iconEmoji: { type: String },
  directKey: { type: String, unique: true, sparse: true },
  createdAt: { type: Date, default: Date.now, required: true },
  updatedAt: { type: Date, default: Date.now, required: true },
});

ConversationSchema.pre("save", async function () {
  if (this.isNew && !(this as any).id) {
    (this as any).id = await getNextSequence("conversationId");
  }
});

export const ConversationModel = mongoose.model<IConversation>("Conversation", ConversationSchema);

// Conversation Member Model
export interface IConversationMember {
  conversationId: number;
  userId: number;
  isAdmin: boolean;
  pinned: boolean;
  muted: boolean;
  lastReadMessageId?: number;
  joinedAt: Date;
}

const ConversationMemberSchema: Schema = new Schema({
  conversationId: { type: Number, ref: "Conversation", required: true },
  userId: { type: Number, ref: "User", required: true },
  isAdmin: { type: Boolean, default: false, required: true },
  pinned: { type: Boolean, default: false, required: true },
  muted: { type: Boolean, default: false, required: true },
  lastReadMessageId: { type: Number, default: 0 },
  joinedAt: { type: Date, default: Date.now, required: true },
});

ConversationMemberSchema.index({ conversationId: 1, userId: 1 }, { unique: true });

export const ConversationMemberModel = mongoose.model<IConversationMember>("ConversationMember", ConversationMemberSchema);

// Message Model
export interface IMessageAttachment {
  name: string;
  url: string;
  size: number;
  mimeType: string;
}

export interface IMessage {
  id: number;
  conversationId: number;
  authorId: number;
  content: string;
  attachments: IMessageAttachment[];
  replyToId?: number;
  mentionsEveryone: boolean;
  editedAt?: Date;
  deletedAt?: Date;
  createdAt: Date;
}

const MessageSchema: Schema = new Schema({
  id: { type: Number, unique: true, index: true },
  conversationId: { type: Number, ref: "Conversation", required: true, index: true },
  authorId: { type: Number, ref: "User", required: true },
  content: { type: String, default: "" },
  attachments: [{
    name: { type: String, required: true },
    url: { type: String, required: true },
    size: { type: Number, required: true },
    mimeType: { type: String, required: true },
  }],
  replyToId: { type: Number, ref: "Message" },
  mentionsEveryone: { type: Boolean, default: false, required: true },
  editedAt: { type: Date },
  deletedAt: { type: Date },
  createdAt: { type: Date, default: Date.now, required: true, index: true },
});

MessageSchema.pre("save", async function () {
  if (this.isNew && !(this as any).id) {
    (this as any).id = await getNextSequence("messageId");
  }
});

export const MessageModel = mongoose.model<IMessage>("Message", MessageSchema);

// Notification Model
export interface INotification {
  id: number;
  userId: number;
  kind: string;
  title: string;
  body: string;
  conversationId?: number;
  messageId?: number;
  readAt?: Date;
  createdAt: Date;
}

const NotificationSchema: Schema = new Schema({
  id: { type: Number, unique: true, index: true },
  userId: { type: Number, ref: "User", required: true, index: true },
  kind: { type: String, required: true },
  title: { type: String, required: true },
  body: { type: String, required: true },
  conversationId: { type: Number, ref: "Conversation" },
  messageId: { type: Number, ref: "Message" },
  readAt: { type: Date },
  createdAt: { type: Date, default: Date.now, required: true },
});

NotificationSchema.pre("save", async function () {
  if (this.isNew && !(this as any).id) {
    (this as any).id = await getNextSequence("notificationId");
  }
});

export const NotificationModel = mongoose.model<INotification>("Notification", NotificationSchema);
