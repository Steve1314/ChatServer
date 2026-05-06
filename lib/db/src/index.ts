import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

let dbInstance: any = null;
let poolInstance: any = null;

if (process.env.DATABASE_URL) {
  poolInstance = new Pool({ connectionString: process.env.DATABASE_URL });
  dbInstance = drizzle(poolInstance, { schema });
}

export const pool = poolInstance;
export const db = dbInstance;

export * from "./schema";
export * from "./mongodb";
export {
  UserModel,
  ConversationModel,
  ConversationMemberModel,
  MessageModel,
  NotificationModel,
  CounterModel,
} from "./mongodb/models";
