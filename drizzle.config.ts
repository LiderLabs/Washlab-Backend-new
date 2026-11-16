import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/platform/db/schema/index.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgresql://washlab_user:washlab_secret_pass@localhost:5433/washlab_db",
  },
  verbose: true,
  strict: true,
});
