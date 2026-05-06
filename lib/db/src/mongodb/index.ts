import mongoose from "mongoose";
import * as models from "./models";
const { CounterModel, UserModel, ConversationModel, ConversationMemberModel, MessageModel, NotificationModel } = models;

/**
 * Ensures that all Counter documents are at or above the highest existing
 * numeric `id` in each collection. Run once after connecting to prevent
 * duplicate-key errors when the counter gets reset across server restarts.
 */
async function repairCounters(): Promise<void> {
  try {
    // Aggressively clean up stale/broken documents and indexes
    await CounterModel.deleteMany({ $or: [{ id: null }, { id: { $exists: false } }, { _id: null }] });
    await CounterModel.collection.dropIndex("id_1_reference_value_1").catch(() => { });
    await CounterModel.collection.dropIndex("id_1").catch(() => { });
  } catch (err) {
    console.warn("Counter cleanup notice:", err);
  }

  const repairs: Array<{ name: string; Model: mongoose.Model<any> }> = [
    { name: "userId", Model: UserModel },
    { name: "conversationId", Model: ConversationModel },
    { name: "messageId", Model: MessageModel },
    { name: "notificationId", Model: NotificationModel },
  ];

  for (const { name, Model } of repairs) {
    try {
      const maxDoc = await Model.findOne({}, { id: 1 }).sort({ id: -1 }).lean();
      const maxId: number = (maxDoc as any)?.id ?? 0;
      if (maxId > 0) {
        await CounterModel.findByIdAndUpdate(
          name,
          { $max: { seq: maxId } },
          { upsert: true, new: true },
        );
      }
    } catch (err) {
      console.error(`Failed to repair counter "${name}":`, err);
    }
  }
  console.log("MongoDB counters verified/repaired.");
}

export const connectMongoDB = async (uri?: string) => {
  const mongoUri = uri || process.env.MONGODB_URI || "mongodb+srv://vivek:vivek@cluster0.cbq8srd.mongodb.net/chatdb?retryWrites=true&w=majority";

  try {
    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB");
    await repairCounters();
  } catch (error) {
    console.error("MongoDB connection error:", error);
    console.warn("Server will continue starting without MongoDB. Some features may be unavailable.");
  }
};

export * from "./models";
export { mongoose };
