import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config/index.js";
import * as schema from "./schema/index.js";

// Primary connection (Read / Write)
const queryClient = postgres(config.DATABASE_URL, {
  max: config.DB_MAX_CONNECTIONS,
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(queryClient, { schema });

// Optional read replica connection
const replicaClient = config.DATABASE_READ_REPLICA_URL
  ? postgres(config.DATABASE_READ_REPLICA_URL, {
      max: config.DB_MAX_CONNECTIONS,
      idle_timeout: 20,
      connect_timeout: 10,
    })
  : queryClient;

export const dbRead = drizzle(replicaClient, { schema });

export async function checkDbConnection(): Promise<boolean> {
  try {
    await queryClient`SELECT 1`;
    return true;
  } catch (error) {
    return false;
  }
}
