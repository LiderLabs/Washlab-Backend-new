import Redis from "ioredis";
import { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";

const redisPublisher = new Redis(config.REDIS_URL, { lazyConnect: true });
const redisSubscriber = new Redis(config.REDIS_URL, { lazyConnect: true });

export async function initRealtime() {
  try {
    await redisPublisher.connect();
    await redisSubscriber.connect();
    logger.info("✅ Redis Pub/Sub connected for real-time SSE");
  } catch (error) {
    logger.warn({ err: error }, "Redis not connected. Local in-memory fallback enabled.");
  }
}

/**
 * Broadcast event to all listening instances via Redis Pub/Sub
 */
export async function broadcastRealtimeEvent(channel: string, event: string, data: unknown) {
  const payload = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  try {
    if (redisPublisher.status === "ready") {
      await redisPublisher.publish(`washlab:${channel}`, payload);
    }
  } catch (err) {
    logger.warn({ err }, `Failed to publish realtime event to channel: ${channel}`);
  }
}

/**
 * Handle Server-Sent Events (SSE) connection
 */
export function handleSseConnection(request: FastifyRequest, reply: FastifyReply, channels: string[]) {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("Access-Control-Allow-Origin", "*");
  reply.raw.flushHeaders();

  // Send initial connection ACK
  reply.raw.write(`event: connected\ndata: ${JSON.stringify({ status: "connected" })}\n\n`);

  // Heartbeat ping every 15s to keep connection alive through ALBs / Cloudflare
  const heartbeat = setInterval(() => {
    reply.raw.write(":ping\n\n");
  }, 15000);

  const subscriber = redisSubscriber.duplicate();

  channels.forEach((ch) => {
    subscriber.subscribe(`washlab:${ch}`);
  });

  subscriber.on("message", (_channel, message) => {
    try {
      const parsed = JSON.parse(message);
      reply.raw.write(`event: ${parsed.event}\ndata: ${JSON.stringify(parsed.data)}\n\n`);
    } catch {
      reply.raw.write(`data: ${message}\n\n`);
    }
  });

  request.raw.on("close", () => {
    clearInterval(heartbeat);
    subscriber.disconnect();
  });
}
