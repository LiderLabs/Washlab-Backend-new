import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { config } from "../config/index.js";
import { logger } from "../logger/index.js";

async function runMigrations() {
  logger.info("⏳ Running database migrations from ./db/migrations...");

  const migrationClient = postgres(config.DATABASE_URL, { max: 1 });
  const db = drizzle(migrationClient);

  try {
    await migrate(db, { migrationsFolder: "./db/migrations" });
    logger.info("✅ Database migrations applied successfully!");
  } catch (error) {
    logger.error({ err: error }, "❌ Migration failed");
    process.exit(1);
  } finally {
    await migrationClient.end();
  }
}

runMigrations();
