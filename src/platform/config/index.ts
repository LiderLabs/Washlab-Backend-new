import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const isProd = process.env.NODE_ENV === "production";

// Dev-only fallbacks. In production none of these apply, so a missing value fails startup.
const devDefaults: Record<string, string> = {
  DATABASE_URL: "postgresql://washlab_user:washlab_secret_pass@localhost:5433/washlab_db",
  REDIS_URL: "redis://localhost:6380",
  CLERK_PUBLISHABLE_KEY: "pk_test_mock_for_dev",
  JWT_SECRET: "development_secret_station_session_jwt_key_32chars",
  BIOMETRIC_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  CORS_ORIGINS: "http://localhost:3000,http://localhost:3001",
};

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Database
  DATABASE_URL: z.string().min(1),
  DATABASE_READ_REPLICA_URL: z.string().optional(),
  DB_MAX_CONNECTIONS: z.coerce.number().default(20),

  // Redis
  REDIS_URL: z.string().min(1),

  // Clerk
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_WEBHOOK_SECRET: isProd ? z.string().min(1) : z.string().optional(),

  // Payments
  PAYSTACK_SECRET_KEY: z.string().min(1),
  PAYSTACK_PUBLIC_KEY: z.string().optional(),
  HUBTEL_CLIENT_ID: z.string().optional(),
  HUBTEL_CLIENT_SECRET: z.string().optional(),
  HUBTEL_MERCHANT_ID: z.string().optional(),

  // Email
  RESEND_API_KEY: z.string().optional(),
  FROM_EMAIL: z.string().default("support@washlab.app"),

  // Security
  JWT_SECRET: z.string().min(32),
  BIOMETRIC_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters"),
  CORS_ORIGINS: z
    .string()
    .min(1)
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
});

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  const source = isProd ? process.env : { ...devDefaults, ...process.env };
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Print field names only, never values
    const fields = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    console.error("Configuration validation failed:\n" + fields.join("\n"));
    throw new Error("Invalid application configuration");
  }
  return result.data;
}

export const config = loadConfig();