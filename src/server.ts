import { buildApp } from "./app.js";
import { config } from "./platform/config/index.js";
import { logger } from "./platform/logger/index.js";
import { initRealtime } from "./platform/realtime/index.js";

async function main() {
  const app = await buildApp();

  // Initialize optional realtime Redis Pub/Sub
  await initRealtime();

  // Start HTTP Server
  try {
    const address = await app.listen({
      port: config.PORT,
      host: config.HOST,
    });
    logger.info(`🚀 WashLab API Server running at ${address}`);
    logger.info(`📚 Swagger OpenAPI documentation available at ${address}/docs`);
  } catch (err) {
    logger.error({ err }, "Failed to start WashLab API Server");
    process.exit(1);
  }

  // Graceful Shutdown
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  signals.forEach((signal) => {
    process.on(signal, async () => {
      logger.info(`Received ${signal}. Gracefully shutting down...`);
      try {
        await app.close();
        logger.info("HTTP server closed.");
        process.exit(0);
      } catch (err) {
        logger.error({ err }, "Error during graceful shutdown");
        process.exit(1);
      }
    });
  });
}

main();
