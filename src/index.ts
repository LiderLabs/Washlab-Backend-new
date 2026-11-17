/**
 * WashLab Core Backend
 * High-performance, scalable backend for WashLab Laundry Operations
 */
if (process.env.NODE_ENV === "production") {
  const required = ["DATABASE_URL", "PAYSTACK_SECRET_KEY", "JWT_SECRET"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);
  }
}

export * from "./platform/db/schema/index.js";
export * from "./platform/errors/index.js";
export * from "./platform/crypto/index.js";
export * from "./modules/branches/schemas.js";
export { buildApp } from "./app.js";