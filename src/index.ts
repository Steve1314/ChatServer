import { createServer } from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { attachRealtime } from "./lib/realtime";
import { ensureSeedData } from "./lib/seed";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createServer(app);
attachRealtime(server);

import { connectMongoDB } from "@workspace/db";

const startServer = async () => {
  await connectMongoDB();
  await ensureSeedData();
  
  server.listen(port, () => {
    logger.info({ port }, "Server listening (HTTP + Socket.IO)");
  });
};

startServer().catch((err: unknown) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
