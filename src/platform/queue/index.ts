import { PgBoss } from "pg-boss";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";

export const boss = new PgBoss({
  connectionString: config.DATABASE_URL,
  max: 5,
  application_name: "washlab-worker",
});

export async function initQueue() {
  boss.on("error", (error: Error) => {
    logger.error({ err: error }, "pg-boss queue encountered an error");
  });

  await boss.start();
  logger.info("✅ pg-boss queue initialized and running");
}

export type OutboxEventPayload = {
  eventType: string;
  aggregateId: string;
  data: Record<string, unknown>;
  timestamp: string;
};

/**
 * Publish an event to the background job queue
 */
export async function publishJob(queueName: string, data: Record<string, unknown>) {
  return await boss.send(queueName, data, {
    retryLimit: 5,
    retryDelay: 30, // seconds
    expireInSeconds: 300,
  });
}
