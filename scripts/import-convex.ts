import "dotenv/config";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/platform/db/schema/index.js";
import { branches } from "../src/platform/db/schema/branches.js";
import { branchMachines, branchServices, services } from "../src/platform/db/schema/catalog.js";
import { customers } from "../src/platform/db/schema/customers.js";
import { cashCredits, cashDeductions, cashLedger, cashReconTransactions } from "../src/platform/db/schema/cash.js";
import { loyaltyLedger, voucherUsages, vouchers } from "../src/platform/db/schema/loyalty.js";
import { orders } from "../src/platform/db/schema/orders.js";
import { payments } from "../src/platform/db/schema/payments.js";
import { subscriptionUsages } from "../src/platform/db/schema/subscription-usages.js";
import { customerSubscriptions, subscriptionPlans } from "../src/platform/db/schema/subscriptions.js";
import { admins, attendantBranches, attendants } from "../src/platform/db/schema/staff.js";

type ConvexDoc = Record<string, unknown>;
type LegacyRow = { id: string; legacyConvexId: string };
type IdMap = Map<string, string>;

const BATCH_SIZE = 500;
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const inputArgIndex = args.findIndex((arg) => arg === "--input-dir");
const inputDirArg = inputArgIndex >= 0 ? args[inputArgIndex + 1] : undefined;
const inputDir = resolve(inputDirArg ?? "convex-export");

if (args.includes("--help")) {
  console.log("Usage: npm exec tsx -- scripts/import-convex.ts [--input-dir <directory>] [--dry-run]");
  console.log("Input: one Convex table JSONL file per source table, e.g. branches.jsonl.");
  process.exit(0);
}

if (inputArgIndex >= 0 && (!inputDirArg || inputDirArg.startsWith("--"))) {
  throw new Error("--input-dir requires a directory path");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must be set before running the import");
const client = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
const db = drizzle(client, { schema });

function sourceId(doc: ConvexDoc): string {
  const id = doc._id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Convex row is missing a string _id");
  }
  return id;
}

function value(doc: ConvexDoc, key: string): unknown {
  return doc[key];
}

function requiredString(doc: ConvexDoc, key: string): string {
  const result = value(doc, key);
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`Missing required string field '${key}'`);
  }
  return result;
}

function optionalString(doc: ConvexDoc, key: string): string | null {
  const result = value(doc, key);
  if (result === undefined || result === null || result === "") return null;
  if (typeof result !== "string") throw new Error(`Expected '${key}' to be a string`);
  return result;
}

function numberValue(doc: ConvexDoc, key: string, fallback = 0): number {
  const result = value(doc, key);
  if (result === undefined || result === null) return fallback;
  const parsed = typeof result === "number" ? result : Number(result);
  if (!Number.isFinite(parsed)) throw new Error(`Expected '${key}' to be a finite number`);
  return parsed;
}

function booleanValue(doc: ConvexDoc, key: string, fallback = false): boolean {
  const result = value(doc, key);
  if (result === undefined || result === null) return fallback;
  if (typeof result !== "boolean") throw new Error(`Expected '${key}' to be a boolean`);
  return result;
}

function timestampValue(doc: ConvexDoc, key: string, fallback?: Date): Date | null {
  const raw = value(doc, key);
  if (raw === undefined || raw === null) return fallback ?? null;
  const millis =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Date.parse(raw)
        : Number.NaN;
  if (!Number.isFinite(millis)) throw new Error(`Expected '${key}' to be a timestamp`);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp in '${key}'`);
  return date;
}

function dateValue(doc: ConvexDoc, key: string): string {
  const raw = value(doc, key);
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = timestampValue(doc, key);
  if (!date) throw new Error(`Missing required date '${key}'`);
  return date.toISOString().slice(0, 10);
}

function toPesewas(amount: number, key: string): bigint {
  const minorUnits = Math.round(amount * 100);
  if (!Number.isSafeInteger(minorUnits)) {
    throw new Error(`Amount '${key}' is outside the safe Pesewas conversion range`);
  }
  return BigInt(minorUnits);
}

function pesewas(doc: ConvexDoc, key: string, fallback = 0): bigint {
  return toPesewas(numberValue(doc, key, fallback), key);
}

function requiredMapId(map: IdMap, rawId: unknown, relation: string): string {
  if (typeof rawId !== "string") throw new Error(`Missing ${relation} reference`);
  const id = map.get(rawId);
  if (!id) throw new Error(`Cannot resolve ${relation} Convex ID '${rawId}'`);
  return id;
}

function optionalMapId(map: IdMap, rawId: unknown, relation: string): string | null {
  if (rawId === undefined || rawId === null) return null;
  return requiredMapId(map, rawId, relation);
}

function mapIdArray(map: IdMap, rawIds: unknown, relation: string): string[] | null {
  if (rawIds === undefined || rawIds === null) return null;
  if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== "string")) {
    throw new Error(`Expected '${relation}' to be an array of Convex IDs`);
  }
  return rawIds.map((id) => requiredMapId(map, id, relation));
}

function jsonObject(doc: ConvexDoc, key: string): Record<string, unknown> | null {
  const raw = value(doc, key);
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Expected '${key}' to be an object`);
  }
  return raw as Record<string, unknown>;
}

function newRowId(legacyId: string, map: IdMap): string {
  return map.get(legacyId) ?? randomUUID();
}

function legacyPinHash(hash: string | null, salt: string | null): string | null {
  if (!hash) return null;
  if (hash.startsWith("legacy-sha256$")) return hash;
  if (salt) return `legacy-sha256$${salt}$${hash}`;
  const parts = hash.split(":");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return `legacy-sha256$${parts[1]}$${parts[0]}`;
  }
  throw new Error("Legacy PIN hash has no salt; refusing to import an unverifiable credential");
}

async function* readJsonl(fileName: string): AsyncGenerator<{ doc: ConvexDoc; line: number }> {
  const path = resolve(inputDir, fileName);
  try {
    await access(path);
  } catch {
    throw new Error(`Missing required export file: ${path}`);
  }
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let line = 0;
  for await (const text of rl) {
    line += 1;
    if (!text.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON in ${fileName}:${line}: ${String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Expected a JSON object in ${fileName}:${line}`);
    }
    yield { doc: parsed as ConvexDoc, line };
  }
}

async function loadIdMap(tableName: string): Promise<IdMap> {
  const rows = await client`
    SELECT id, legacy_convex_id
    FROM ${client(tableName)}
    WHERE legacy_convex_id IS NOT NULL
  `;
  return new Map(rows.map((row) => [String(row.legacy_convex_id), String(row.id)]));
}

async function loadPhoneMap(): Promise<Map<string, string>> {
  const rows = await db.select({ id: customers.id, phoneNumber: customers.phoneNumber }).from(customers);
  return new Map(rows.map((row) => [row.phoneNumber, row.id]));
}

async function runStage<T extends LegacyRow>(
  name: string,
  fileName: string,
  idMap: IdMap,
  mapper: (doc: ConvexDoc) => T,
  insert: (rows: T[]) => Promise<number>,
  afterInsert?: (rows: T[]) => Promise<void>
): Promise<void> {
  let chunk: T[] = [];
  let sourceCount = 0;
  let existingCount = 0;
  let writeCount = 0;
  const flush = async () => {
    if (chunk.length === 0) return;
    const newRows = chunk.filter((row) => !idMap.has(row.legacyConvexId));
    const rows = chunk.map((row) => {
      const actualId = idMap.get(row.legacyConvexId);
      return actualId ? { ...row, id: actualId } : row;
    });
    if (dryRun) {
      existingCount += chunk.length - newRows.length;
      writeCount += newRows.length;
    } else {
      writeCount += await insert(rows);
      existingCount += chunk.length - newRows.length;
    }
    for (const row of rows) idMap.set(row.legacyConvexId, row.id);
    if (afterInsert) await afterInsert(rows);
    chunk = [];
  };

  for await (const { doc, line } of readJsonl(fileName)) {
    try {
      const row = mapper(doc);
      const existingId = idMap.get(row.legacyConvexId);
      if (existingId) row.id = existingId;
      chunk.push(row);
      sourceCount += 1;
      if (chunk.length === BATCH_SIZE) await flush();
    } catch (error) {
      throw new Error(`${fileName}:${line} (_id=${String(doc._id)}): ${String(error)}`);
    }
  }
  await flush();
  console.log(
    `${dryRun ? "DRY RUN " : ""}${name}: ${sourceCount} source rows; ` +
      `${dryRun ? `would insert ${writeCount}` : `inserted ${writeCount}`}; skipped ${existingCount} existing`
  );
}

function pinWithSourceFields(doc: ConvexDoc, hashKey: string, saltKey: string): string | null {
  return legacyPinHash(optionalString(doc, hashKey), optionalString(doc, saltKey));
}

async function insertRows<T>(rows: T[], write: (values: T[]) => Promise<unknown[]>): Promise<number> {
  const inserted = await write(rows);
  return inserted.length;
}

async function ensureGuestCustomers(
  customerIds: IdMap,
  phoneIds: Map<string, string>,
  orderFile = "orders.jsonl"
): Promise<void> {
  let pending: (typeof customers.$inferInsert)[] = [];
  let created = 0;
  const flush = async () => {
    if (pending.length === 0) return;
    const rows = pending;
    pending = [];
    if (!dryRun) {
      await db.insert(customers).values(rows).onConflictDoNothing();
    }
    for (const row of rows) {
      if (row.phoneNumber) phoneIds.set(row.phoneNumber, row.id!);
      if (row.legacyConvexId) customerIds.set(row.legacyConvexId, row.id!);
    }
  };

  for await (const { doc, line } of readJsonl(orderFile)) {
    const customerRef = optionalString(doc, "customerId");
    if (customerRef && customerIds.has(customerRef)) continue;
    const phone = optionalString(doc, "customerPhoneNumber");
    if (!phone) {
      throw new Error(`${orderFile}:${line}: order without a customer mapping has no customerPhoneNumber`);
    }
    if (phoneIds.has(phone)) continue;
    const legacyConvexId = `legacy-guest:${phone}`;
    if (customerIds.has(legacyConvexId)) continue;
    const createdAt = timestampValue(doc, "createdAt", new Date()) ?? new Date();
    const id = randomUUID();
    pending.push({
      id,
      legacyConvexId,
      name: "Walk-in customer",
      phoneNumber: phone,
      email: optionalString(doc, "customerEmail"),
      clerkUserId: null,
      branchId: null,
      loyaltyPoints: 0,
      status: "active",
      isRegistered: false,
      isVerified: false,
      createdAt,
      updatedAt: createdAt,
    });
    phoneIds.set(phone, id);
    customerIds.set(legacyConvexId, id);
    created += 1;
    if (pending.length === BATCH_SIZE) await flush();
  }
  await flush();
  console.log(`${dryRun ? "DRY RUN " : ""}Guest customers: ${dryRun ? "would create" : "created"} ${created}`);
}

async function main(): Promise<void> {
  if (!dryRun) {
    console.log(`Importing Convex JSONL from ${inputDir} in batches of ${BATCH_SIZE}`);
  } else {
    console.log(`DRY RUN: no writes will be performed; reading ${inputDir} in batches of ${BATCH_SIZE}`);
  }

  const ids = {
    admins: await loadIdMap("admins"),
    branches: await loadIdMap("branches"),
    attendants: await loadIdMap("attendants"),
    customers: await loadIdMap("customers"),
    branchServices: await loadIdMap("branch_services"),
    branchMachines: await loadIdMap("branch_machines"),
    services: await loadIdMap("services"),
    subscriptionPlans: await loadIdMap("subscription_plans"),
    customerSubscriptions: await loadIdMap("customer_subscriptions"),
    orders: await loadIdMap("orders"),
    payments: await loadIdMap("payments"),
    cashLedger: await loadIdMap("cash_ledger"),
    cashDeductions: await loadIdMap("cash_deductions"),
    cashReconTransactions: await loadIdMap("cash_recon_transactions"),
    cashCredits: await loadIdMap("cash_credits"),
    loyaltyLedger: await loadIdMap("loyalty_ledger"),
    vouchers: await loadIdMap("vouchers"),
    voucherUsages: await loadIdMap("voucher_usages"),
    subscriptionUsages: await loadIdMap("subscription_usages"),
  };

  const sourceDocBranches = new Map<string, unknown[]>();
  for await (const { doc } of readJsonl("attendants.jsonl")) {
    const raw = value(doc, "branchIds");
    if (Array.isArray(raw)) sourceDocBranches.set(sourceId(doc), raw);
  }

  await runStage(
    "Admin prerequisite",
    "admins.jsonl",
    ids.admins,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      const createdAt = timestampValue(doc, "createdAt", new Date()) ?? new Date();
      return {
        id: newRowId(legacyConvexId, ids.admins),
        legacyConvexId,
        name: requiredString(doc, "name"),
        email: requiredString(doc, "email"),
        clerkUserId: requiredString(doc, "clerkUserId"),
        role: value(doc, "role") === "super_admin" ? "super_admin" : "admin",
        deletedAt: booleanValue(doc, "isDeleted") ? timestampValue(doc, "createdAt", createdAt) : null,
        createdAt,
        updatedAt: createdAt,
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(admins).values(values).onConflictDoNothing({ target: admins.legacyConvexId }).returning({ id: admins.id })
    )
  );

  await runStage(
    "Branches",
    "branches.jsonl",
    ids.branches,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      const createdAt = timestampValue(doc, "createdAt", new Date()) ?? new Date();
      return {
        id: newRowId(legacyConvexId, ids.branches),
        legacyConvexId,
        name: requiredString(doc, "name"),
        code: requiredString(doc, "code"),
        terminalId: optionalString(doc, "terminalId"),
        phoneNumber: requiredString(doc, "phoneNumber"),
        email: optionalString(doc, "email"),
        address: requiredString(doc, "address"),
        city: requiredString(doc, "city"),
        pricingPerKgPesewas: pesewas(doc, "pricingPerKg"),
        deliveryFeePesewas: pesewas(doc, "deliveryFee"),
        stationPinHash: legacyPinHash(optionalString(doc, "stationPinHash"), null),
        requireStationLogin: booleanValue(doc, "requireStationLogin", true),
        weeklyOrderTarget: value(doc, "weeklyOrderTarget") == null ? 0 : numberValue(doc, "weeklyOrderTarget"),
        creditAutoApplyDisabled: booleanValue(doc, "creditAutoApplyDisabled"),
        momoNumber: optionalString(doc, "momoNumber"),
        deliveryFees: jsonObject(doc, "deliveryFees"),
        isActive: booleanValue(doc, "isActive", true),
        deletedAt: booleanValue(doc, "isDeleted") ? timestampValue(doc, "createdAt", createdAt) : null,
        createdAt,
        updatedAt: createdAt,
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(branches).values(values).onConflictDoNothing({ target: branches.legacyConvexId }).returning({ id: branches.id })
    )
  );

  await runStage(
    "Global services",
    "services.jsonl",
    ids.services,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      const createdAt = timestampValue(doc, "createdAt", new Date()) ?? new Date();
      return {
        id: newRowId(legacyConvexId, ids.services),
        legacyConvexId,
        name: requiredString(doc, "name"),
        code: requiredString(doc, "code"),
        description: optionalString(doc, "description"),
        imageUrl: optionalString(doc, "imageUrl"),
        basePricePesewas: pesewas(doc, "basePrice"),
        pricingType: optionalString(doc, "pricingType") ?? "per_load",
        isActive: booleanValue(doc, "isActive", true),
        deletedAt: booleanValue(doc, "isDeleted") ? timestampValue(doc, "createdAt", createdAt) : null,
        createdAt,
        updatedAt: timestampValue(doc, "updatedAt", createdAt) ?? createdAt,
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(services).values(values).onConflictDoNothing({ target: services.legacyConvexId }).returning({ id: services.id })
    )
  );

  await runStage(
    "Branch services",
    "branchServices.jsonl",
    ids.branchServices,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      const createdAt = timestampValue(doc, "createdAt", new Date()) ?? new Date();
      return {
        id: newRowId(legacyConvexId, ids.branchServices),
        legacyConvexId,
        branchId: requiredMapId(ids.branches, value(doc, "branchId"), "branch"),
        name: requiredString(doc, "name"),
        code: optionalString(doc, "code") ?? requiredString(doc, "name").toLowerCase().replace(/[^a-z0-9]+/g, "_"),
        description: optionalString(doc, "description"),
        imageUrl: optionalString(doc, "imageUrl"),
        pricePesewas: pesewas(doc, "price"),
        extraWashPricePesewas: value(doc, "extraWashPrice") == null ? null : pesewas(doc, "extraWashPrice"),
        extraDryPricePesewas: value(doc, "extraDryPrice") == null ? null : pesewas(doc, "extraDryPrice"),
        isActive: booleanValue(doc, "isActive", true),
        showOnCustomerSide: booleanValue(doc, "showOnCustomerSide", true),
        deletedAt: booleanValue(doc, "isDeleted") ? timestampValue(doc, "createdAt", createdAt) : null,
        createdAt,
        updatedAt: timestampValue(doc, "updatedAt", createdAt) ?? createdAt,
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(branchServices).values(values).onConflictDoNothing({ target: branchServices.legacyConvexId }).returning({ id: branchServices.id })
    )
  );

  await runStage(
    "Branch machines",
    "branchMachines.jsonl",
    ids.branchMachines,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      const createdAt = timestampValue(doc, "createdAt", new Date()) ?? new Date();
      return {
        id: newRowId(legacyConvexId, ids.branchMachines),
        legacyConvexId,
        branchId: requiredMapId(ids.branches, value(doc, "branchId"), "branch"),
        name: requiredString(doc, "name"),
        displayName: optionalString(doc, "displayName"),
        serialNumber: optionalString(doc, "serialNumber"),
        otherDetails: optionalString(doc, "otherDetails"),
        washPricePesewas: pesewas(doc, "washPrice"),
        isActive: booleanValue(doc, "isActive", true),
        deletedAt: booleanValue(doc, "isDeleted") ? timestampValue(doc, "createdAt", createdAt) : null,
        createdAt,
        updatedAt: createdAt,
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(branchMachines).values(values).onConflictDoNothing({ target: branchMachines.legacyConvexId }).returning({ id: branchMachines.id })
    )
  );

  await runStage(
    "Attendants",
    "attendants.jsonl",
    ids.attendants,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      const createdAt = timestampValue(doc, "createdAt", new Date()) ?? new Date();
      const enrollmentStatus = optionalString(doc, "enrollmentStatus");
      const status =
        !booleanValue(doc, "isActive", true) || enrollmentStatus === "suspended"
          ? "suspended"
          : enrollmentStatus === "active" || enrollmentStatus === "biometric_complete"
            ? "active"
            : enrollmentStatus === "locked"
              ? "locked"
              : "invited";
      return {
        id: newRowId(legacyConvexId, ids.attendants),
        legacyConvexId,
        branchId: requiredMapId(ids.branches, value(doc, "branchId"), "branch"),
        clerkUserId: optionalString(doc, "clerkUserId"),
        name: requiredString(doc, "name"),
        email: requiredString(doc, "email"),
        phoneNumber: requiredString(doc, "phoneNumber"),
        passcodeHash: pinWithSourceFields(doc, "passcodeHash", "passcodeSalt"),
        status,
        enrollmentTokenHash: optionalString(doc, "enrollmentTokenHash"),
        enrollmentTokenExpiresAt: timestampValue(doc, "enrollmentTokenExpiresAt"),
        enrolledAt: timestampValue(doc, "enrolledAt"),
        failedAttempts: numberValue(doc, "consecutiveFailures"),
        lockedUntil: timestampValue(doc, "verificationTimeoutAt"),
        deletedAt: booleanValue(doc, "isDeleted") ? timestampValue(doc, "createdAt", createdAt) : null,
        createdAt,
        updatedAt: createdAt,
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(attendants).values(values).onConflictDoNothing({ target: attendants.legacyConvexId }).returning({ id: attendants.id })
    ),
    async (rows) => {
      const branchAccess = rows.flatMap((row) => {
        const docBranches = sourceDocBranches.get(row.legacyConvexId) ?? [];
        return docBranches.map((branchId) => ({
          attendantId: row.id,
          branchId: requiredMapId(ids.branches, branchId, "attendant branch access"),
        }));
      });
      if (!dryRun && branchAccess.length > 0) {
        await db.insert(attendantBranches).values(branchAccess).onConflictDoNothing();
      }
    }
  );

  const phoneIds = await loadPhoneMap();

  await runStage(
    "Customers",
    "users.jsonl",
    ids.customers,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      const createdAt = timestampValue(doc, "createdAt", new Date()) ?? new Date();
      return {
        id: newRowId(legacyConvexId, ids.customers),
        legacyConvexId,
        clerkUserId: optionalString(doc, "clerkUserId"),
        name: requiredString(doc, "name"),
        phoneNumber: requiredString(doc, "phoneNumber"),
        email: optionalString(doc, "email"),
        branchId: optionalMapId(ids.branches, value(doc, "preferredBranchId") ?? value(doc, "branchId"), "customer branch"),
        loyaltyPoints: 0,
        status: optionalString(doc, "status") ?? "active",
        statusNote: optionalString(doc, "statusNote"),
        statusChangedBy: ids.admins.get(optionalString(doc, "statusChangedBy") ?? "") ?? null,
        statusChangedAt: timestampValue(doc, "statusChangedAt"),
        isRegistered: booleanValue(doc, "isRegistered"),
        isVerified: booleanValue(doc, "isVerified"),
        deletedAt: booleanValue(doc, "isDeleted") ? timestampValue(doc, "createdAt", createdAt) : null,
        createdAt,
        updatedAt: createdAt,
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(customers).values(values).onConflictDoNothing({ target: customers.legacyConvexId }).returning({ id: customers.id })
    ),
    async (rows) => {
      for (const row of rows) phoneIds.set(row.phoneNumber, row.id);
    }
  );
  await ensureGuestCustomers(ids.customers, phoneIds);

  await runStage(
    "Subscription plans",
    "subscriptionPlans.jsonl",
    ids.subscriptionPlans,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      const createdAt = timestampValue(doc, "createdAt", new Date()) ?? new Date();
      const rawServices = value(doc, "applicableServiceTypes");
      if (rawServices !== undefined && rawServices !== null && !Array.isArray(rawServices)) {
        throw new Error("Expected 'applicableServiceTypes' to be an array");
      }
      return {
        id: newRowId(legacyConvexId, ids.subscriptionPlans),
        legacyConvexId,
        name: requiredString(doc, "name"),
        description: optionalString(doc, "description"),
        pricePesewas: pesewas(doc, "price"),
        loadsIncluded: numberValue(doc, "loadsIncluded"),
        validityDays: numberValue(doc, "validityDays"),
        applicableBranches: mapIdArray(ids.branches, value(doc, "applicableBranches"), "plan branch"),
        applicableServiceTypes: rawServices ? rawServices.map((item) => String(item)) : null,
        template: optionalString(doc, "template"),
        headline: optionalString(doc, "headline"),
        sortOrder: numberValue(doc, "sortOrder"),
        isActive: booleanValue(doc, "isActive", true),
        createdByAdminId: requiredMapId(ids.admins, value(doc, "createdBy"), "plan creator admin"),
        createdAt,
        updatedAt: timestampValue(doc, "updatedAt", createdAt) ?? createdAt,
        deletedAt: booleanValue(doc, "isDeleted") ? timestampValue(doc, "updatedAt", createdAt) : null,
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(subscriptionPlans).values(values).onConflictDoNothing({ target: subscriptionPlans.legacyConvexId }).returning({ id: subscriptionPlans.id })
    )
  );

  await runStage(
    "Customer subscriptions",
    "customerSubscriptions.jsonl",
    ids.customerSubscriptions,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      const createdAt = timestampValue(doc, "createdAt", new Date()) ?? new Date();
      const customerRef = value(doc, "customerId");
      const phone = requiredString(doc, "phoneNumber");
      const customerId =
        typeof customerRef === "string" && ids.customers.has(customerRef)
          ? ids.customers.get(customerRef)!
          : phoneIds.get(phone) ?? null;
      const rawServices = value(doc, "applicableServiceTypes");
      if (rawServices !== undefined && rawServices !== null && !Array.isArray(rawServices)) {
        throw new Error("Expected 'applicableServiceTypes' to be an array");
      }
      return {
        id: newRowId(legacyConvexId, ids.customerSubscriptions),
        legacyConvexId,
        customerId,
        phoneNumber: phone,
        customerName: requiredString(doc, "customerName"),
        planId: requiredMapId(ids.subscriptionPlans, value(doc, "planId"), "subscription plan"),
        planName: requiredString(doc, "planName"),
        planPricePesewas: pesewas(doc, "planPrice"),
        loadsTotal: numberValue(doc, "loadsTotal"),
        loadsUsed: numberValue(doc, "loadsUsed"),
        validityDays: numberValue(doc, "validityDays"),
        applicableServiceTypes: rawServices ? rawServices.map((item) => String(item)) : null,
        applicableBranches: mapIdArray(ids.branches, value(doc, "applicableBranches"), "subscription branch"),
        purchaseBranchId: optionalMapId(ids.branches, value(doc, "purchaseBranchId"), "purchase branch"),
        code: requiredString(doc, "code"),
        status: value(doc, "status") === "active" || value(doc, "status") === "cancelled" ? value(doc, "status") : "pending_payment",
        source: value(doc, "source") === "admin_grant" ? "admin_grant" : "online",
        paymentReference: optionalString(doc, "paymentReference"),
        note: optionalString(doc, "note"),
        email: optionalString(doc, "email"),
        paidAt: timestampValue(doc, "paidAt"),
        activatedAt: timestampValue(doc, "activatedAt"),
        expiresAt: timestampValue(doc, "expiresAt"),
        cancelledAt: timestampValue(doc, "cancelledAt"),
        cancelReason: optionalString(doc, "cancelReason"),
        createdAt,
        updatedAt: timestampValue(doc, "updatedAt", createdAt) ?? createdAt,
        deletedAt: booleanValue(doc, "isDeleted") ? timestampValue(doc, "updatedAt", createdAt) : null,
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(customerSubscriptions).values(values).onConflictDoNothing({ target: customerSubscriptions.legacyConvexId }).returning({ id: customerSubscriptions.id })
    )
  );

  await runStage(
    "Orders",
    "orders.jsonl",
    ids.orders,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      const createdAt = timestampValue(doc, "createdAt", new Date()) ?? new Date();
      const customerRef = optionalString(doc, "customerId");
      const customerId =
        (customerRef && ids.customers.get(customerRef)) ||
        phoneIds.get(requiredString(doc, "customerPhoneNumber"));
      if (!customerId) throw new Error("Could not resolve a customer for this order");
      const rawStatus = optionalString(doc, "status") ?? "pending_dropoff";
      const statusMap: Record<string, string> = {
        pending: "pending_dropoff",
        in_progress: "washing",
        ready: "ready_for_pickup",
      };
      const status = statusMap[rawStatus] ?? rawStatus;
      const allowedStatuses = new Set([
        "pending_dropoff", "checked_in", "sorting", "washing", "drying",
        "folding", "ready_for_pickup", "out_for_delivery", "delivered",
        "completed", "cancelled",
      ]);
      if (!allowedStatuses.has(status)) throw new Error(`Unsupported order status '${rawStatus}'`);
      const method = optionalString(doc, "paymentMethod");
      const paymentMethod =
        method === "cash" || method === "mobile_money" || method === "card" || method === "voucher" || method === "subscription"
          ? method
          : null;
      const totalPrice = numberValue(doc, "totalPrice", numberValue(doc, "basePrice"));
      const deliveryFee = numberValue(doc, "deliveryFee");
      const finalPrice = numberValue(doc, "finalPrice", totalPrice + deliveryFee);
      const createdBy = optionalMapId(ids.attendants, value(doc, "createdBy"), "order creator attendant");
      const branchId = requiredMapId(ids.branches, value(doc, "branchId"), "order branch");
      const row = {
        id: newRowId(legacyConvexId, ids.orders),
        legacyConvexId,
        orderNumber: requiredString(doc, "orderNumber"),
        customerId,
        branchId,
        orderType: value(doc, "orderType") === "walk_in" ? "walk_in" : "online",
        serviceType: requiredString(doc, "serviceType"),
        bagNumber: optionalString(doc, "bagCardNumber"),
        itemCount: value(doc, "itemCount") == null ? null : numberValue(doc, "itemCount"),
        estimatedLoads: value(doc, "estimatedLoads") == null ? null : numberValue(doc, "estimatedLoads"),
        extraWashLoads: numberValue(doc, "extraWashLoads"),
        extraDryLoads: numberValue(doc, "extraDryLoads"),
        machineId: optionalMapId(ids.branchMachines, value(doc, "machineId"), "order machine"),
        whitesSeparate: booleanValue(doc, "whitesSeparate"),
        notes: optionalString(doc, "notes"),
        isDelivery: booleanValue(doc, "isDelivery"),
        deliveryAddress: optionalString(doc, "deliveryAddress"),
        deliveryPhone: optionalString(doc, "deliveryPhoneNumber"),
        deliveryHall: optionalString(doc, "deliveryHall"),
        deliveryRoom: optionalString(doc, "deliveryRoom"),
        paymentMethod,
        subscriptionId: optionalMapId(ids.customerSubscriptions, value(doc, "subscriptionId"), "order subscription"),
        subscriptionLoadsUsed: value(doc, "subscriptionLoadsUsed") == null ? null : numberValue(doc, "subscriptionLoadsUsed"),
        status,
        weightKg: value(doc, "actualWeight") == null && value(doc, "estimatedWeight") == null
          ? null
          : String(numberValue(doc, "actualWeight", numberValue(doc, "estimatedWeight"))),
        basePricePesewas: pesewas(doc, "basePrice"),
        servicePricePesewas: toPesewas(totalPrice, "totalPrice"),
        deliveryFeePesewas: pesewas(doc, "deliveryFee"),
        discountPesewas: toPesewas(Math.max(0, totalPrice + deliveryFee - finalPrice), "discount"),
        finalPricePesewas: pesewas(doc, "finalPrice", totalPrice + deliveryFee),
        paymentStatus: value(doc, "paymentStatus") === "paid" || value(doc, "paymentStatus") === "failed" || value(doc, "paymentStatus") === "refunded"
          ? value(doc, "paymentStatus")
          : "pending",
        createdByAttendantId: createdBy,
        checkedInAt: timestampValue(doc, "checkedInAt"),
        fulfilledByAttendantId: optionalMapId(ids.attendants, value(doc, "fulfilledBy"), "order attendant"),
        placedAt: createdAt,
        completedAt: status === "completed" ? timestampValue(doc, "updatedAt", createdAt) : null,
        deletedAt: booleanValue(doc, "isDeleted") ? timestampValue(doc, "updatedAt", createdAt) : null,
        createdAt,
        updatedAt: timestampValue(doc, "updatedAt", createdAt) ?? createdAt,
      };
      orderByLegacyId.set(legacyConvexId, { customerId, branchId });
      return row;
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(orders).values(values).onConflictDoNothing({ target: orders.legacyConvexId }).returning({ id: orders.id })
    )
  );

  await runStage(
    "Subscription usages",
    "subscriptionUsages.jsonl",
    ids.subscriptionUsages,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      return {
        id: newRowId(legacyConvexId, ids.subscriptionUsages),
        legacyConvexId,
        subscriptionId: requiredMapId(ids.customerSubscriptions, value(doc, "subscriptionId"), "subscription usage subscription"),
        orderId: requiredMapId(ids.orders, value(doc, "orderId"), "subscription usage order"),
        branchId: requiredMapId(ids.branches, value(doc, "branchId"), "subscription usage branch"),
        attendantId: optionalMapId(ids.attendants, value(doc, "attendantId"), "subscription usage attendant"),
        loadsUsed: numberValue(doc, "loadsUsed"),
        extraWash: numberValue(doc, "extraWash"),
        extraDry: numberValue(doc, "extraDry"),
        loadsRemainingAfter: numberValue(doc, "loadsRemainingAfter"),
        usedAt: timestampValue(doc, "usedAt", new Date()) ?? new Date(),
        deletedAt: booleanValue(doc, "isDeleted") ? timestampValue(doc, "usedAt", new Date()) : null,
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(subscriptionUsages).values(values).onConflictDoNothing({ target: subscriptionUsages.legacyConvexId }).returning({ id: subscriptionUsages.id })
    )
  );

  await runStage(
    "Payments",
    "payments.jsonl",
    ids.payments,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      const orderId = requiredMapId(ids.orders, value(doc, "orderId"), "payment order");
      const order = orderByLegacyId.get(optionalString(doc, "orderId") ?? "");
      const customerRef = optionalString(doc, "customerId");
      const customerId =
        (customerRef && ids.customers.get(customerRef)) ||
        (order ? order.customerId : null);
      if (!customerId) throw new Error("Could not resolve the payment customer");
      const oldStatus = optionalString(doc, "status");
      const status =
        oldStatus === "completed" ? "paid"
          : oldStatus === "failed" ? "failed"
            : oldStatus === "refunded" ? "refunded"
              : "pending";
      const method = optionalString(doc, "paymentMethod");
      if (method !== "cash" && method !== "mobile_money" && method !== "card") {
        throw new Error(`Unsupported payment method '${String(method)}'`);
      }
      return {
        id: newRowId(legacyConvexId, ids.payments),
        legacyConvexId,
        orderId,
        branchId: optionalString(doc, "branchId")
          ? requiredMapId(ids.branches, value(doc, "branchId"), "payment branch")
          : order?.branchId ?? (() => { throw new Error("Could not resolve the payment branch from its order"); })(),
        customerId,
        amountPesewas: pesewas(doc, "amount"),
        currency: optionalString(doc, "currency") ?? "GHS",
        method,
        status,
        gatewayReference: null,
        gatewayTransactionId: optionalString(doc, "gatewayTransactionId"),
        processedByAttendantId: optionalMapId(ids.attendants, value(doc, "processedBy"), "payment attendant"),
        metadata: optionalString(doc, "gatewayResponse") ? { legacyGatewayResponse: optionalString(doc, "gatewayResponse") } : null,
        paidAt: status === "paid" ? timestampValue(doc, "completedAt") : null,
        createdAt: timestampValue(doc, "createdAt", new Date()) ?? new Date(),
        updatedAt: timestampValue(doc, "completedAt", timestampValue(doc, "createdAt", new Date()) ?? new Date()) ?? new Date(),
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(payments).values(values).onConflictDoNothing({ target: payments.legacyConvexId }).returning({ id: payments.id })
    )
  );

  await runStage(
    "Cash ledger",
    "branchCashLedger.jsonl",
    ids.cashLedger,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      return {
        id: newRowId(legacyConvexId, ids.cashLedger),
        legacyConvexId,
        branchId: requiredMapId(ids.branches, value(doc, "branchId"), "cash ledger branch"),
        day: dateValue(doc, "date"),
        collected: pesewas(doc, "collected"),
        orderCount: numberValue(doc, "orderCount"),
        sent: pesewas(doc, "sent"),
        deducted: pesewas(doc, "deducted"),
        creditApplied: pesewas(doc, "creditApplied"),
        updatedAt: timestampValue(doc, "updatedAt", new Date()) ?? new Date(),
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(cashLedger).values(values).onConflictDoNothing({ target: cashLedger.legacyConvexId }).returning({ id: cashLedger.id })
    )
  );

  await runStage(
    "Cash deductions",
    "cashDeductions.jsonl",
    ids.cashDeductions,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      const createdAt = timestampValue(doc, "createdAt", new Date()) ?? new Date();
      return {
        id: newRowId(legacyConvexId, ids.cashDeductions),
        legacyConvexId,
        branchId: requiredMapId(ids.branches, value(doc, "branchId"), "deduction branch"),
        attendantId: optionalMapId(ids.attendants, value(doc, "attendantId"), "deduction attendant"),
        amountPesewas: pesewas(doc, "amount"),
        reason: requiredString(doc, "reason"),
        day: createdAt.toISOString().slice(0, 10),
        createdAt,
        deletedAt: booleanValue(doc, "isDeleted") ? createdAt : null,
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(cashDeductions).values(values).onConflictDoNothing({ target: cashDeductions.legacyConvexId }).returning({ id: cashDeductions.id })
    )
  );

  await runStage(
    "Cash reconciliations",
    "cashReconciliations.jsonl",
    ids.cashReconTransactions,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      const createdAt = timestampValue(doc, "createdAt", new Date()) ?? new Date();
      const reference = optionalString(doc, "paystackReference") ?? `LEGACY-CASH-${legacyConvexId}`;
      const status = optionalString(doc, "status");
      return {
        id: newRowId(legacyConvexId, ids.cashReconTransactions),
        legacyConvexId,
        branchId: requiredMapId(ids.branches, value(doc, "branchId"), "reconciliation branch"),
        attendantId: optionalMapId(ids.attendants, value(doc, "attendantId"), "reconciliation attendant"),
        paystackReference: reference,
        paystackTransactionId: optionalString(doc, "paystackTransactionId"),
        amountSentPesewas: pesewas(doc, "amountSent"),
        senderMomoNumber: requiredString(doc, "senderMomoNumber"),
        network: optionalString(doc, "network"),
        status: status === "processing" || status === "completed" || status === "failed" ? status : "pending",
        excessPesewas: pesewas(doc, "excessAmount"),
        notes: optionalString(doc, "notes"),
        createdAt,
        completedAt: timestampValue(doc, "completedAt"),
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(cashReconTransactions).values(values).onConflictDoNothing({ target: cashReconTransactions.legacyConvexId }).returning({ id: cashReconTransactions.id })
    )
  );

  await runStage(
    "Cash credits",
    "branchCashCredits.jsonl",
    ids.cashCredits,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      const createdAt = timestampValue(doc, "createdAt", new Date()) ?? new Date();
      return {
        id: newRowId(legacyConvexId, ids.cashCredits),
        legacyConvexId,
        branchId: requiredMapId(ids.branches, value(doc, "branchId"), "cash credit branch"),
        day: dateValue(doc, "date"),
        amountPesewas: pesewas(doc, "amount"),
        remainingPesewas: pesewas(doc, "remaining", numberValue(doc, "amount")),
        transactionId: requiredMapId(ids.cashReconTransactions, value(doc, "reconciliationId"), "cash credit reconciliation"),
        createdAt,
        updatedAt: timestampValue(doc, "updatedAt", createdAt) ?? createdAt,
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(cashCredits).values(values).onConflictDoNothing({ target: cashCredits.legacyConvexId }).returning({ id: cashCredits.id })
    )
  );

  await runStage(
    "Loyalty transactions",
    "loyaltyTransactions.jsonl",
    ids.loyaltyLedger,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      const type = optionalString(doc, "type") ?? "adjusted";
      const points = numberValue(doc, "points");
      const pointsDelta = type === "redeemed" || type === "expired" ? -Math.abs(points) : points;
      const createdAt = timestampValue(doc, "createdAt", new Date()) ?? new Date();
      return {
        id: newRowId(legacyConvexId, ids.loyaltyLedger),
        legacyConvexId,
        customerId: requiredMapId(ids.customers, value(doc, "customerId"), "loyalty customer"),
        orderId: optionalMapId(ids.orders, value(doc, "orderId"), "loyalty order"),
        pointsDelta,
        balanceAfter: numberValue(doc, "balanceAfter"),
        reason: (optionalString(doc, "description") ?? type).slice(0, 64),
        description: optionalString(doc, "description"),
        createdAt,
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(loyaltyLedger).values(values).onConflictDoNothing({ target: loyaltyLedger.legacyConvexId }).returning({ id: loyaltyLedger.id })
    )
  );

  let snapshotCount = 0;
  for await (const { doc, line } of readJsonl("loyaltyPoints.jsonl")) {
    try {
      const customerId = requiredMapId(ids.customers, value(doc, "customerId"), "loyalty customer");
      if (!dryRun) {
        await db.update(customers).set({ loyaltyPoints: numberValue(doc, "points") }).where(eq(customers.id, customerId));
      }
      snapshotCount += 1;
    } catch (error) {
      throw new Error(`loyaltyPoints.jsonl:${line}: ${String(error)}`);
    }
  }
  console.log(`${dryRun ? "DRY RUN " : ""}Loyalty balances: ${snapshotCount} customer snapshots`);

  await runStage(
    "Vouchers",
    "vouchers.jsonl",
    ids.vouchers,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      const createdAt = timestampValue(doc, "createdAt", new Date()) ?? new Date();
      const branchIds = mapIdArray(ids.branches, value(doc, "applicableBranches"), "voucher branch");
      const applicableServices = value(doc, "applicableServiceTypes");
      if (applicableServices !== undefined && applicableServices !== null && !Array.isArray(applicableServices)) {
        throw new Error("Expected 'applicableServiceTypes' to be an array");
      }
      return {
        id: newRowId(legacyConvexId, ids.vouchers),
        legacyConvexId,
        code: requiredString(doc, "code"),
        name: optionalString(doc, "name"),
        branchId: branchIds?.length === 1 ? branchIds[0] : null,
        applicableBranches: branchIds && branchIds.length > 1 ? branchIds : null,
        discountType: requiredString(doc, "discountType"),
        discountValue: value(doc, "discountType") === "fixed" ? pesewas(doc, "discountValue") : BigInt(numberValue(doc, "discountValue")),
        minOrderAmountPesewas: pesewas(doc, "minOrderValue"),
        maxUsageCount: numberValue(doc, "usageLimit"),
        currentUsageCount: numberValue(doc, "usedCount"),
        maxUsesPerCustomer: value(doc, "maxUsesPerCustomer") == null ? null : numberValue(doc, "maxUsesPerCustomer"),
        validFrom: timestampValue(doc, "validFrom"),
        applicableServices: applicableServices ? applicableServices.map((item) => String(item)) : null,
        batchId: optionalString(doc, "batchId"),
        expiresAt: timestampValue(doc, "validUntil"),
        isActive: booleanValue(doc, "isActive", true),
        deletedAt: booleanValue(doc, "isDeleted") ? createdAt : null,
        createdAt,
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(vouchers).values(values).onConflictDoNothing({ target: vouchers.legacyConvexId }).returning({ id: vouchers.id })
    )
  );

  await runStage(
    "Voucher usages",
    "voucherUsages.jsonl",
    ids.voucherUsages,
    (doc) => {
      const legacyConvexId = sourceId(doc);
      return {
        id: newRowId(legacyConvexId, ids.voucherUsages),
        legacyConvexId,
        voucherId: requiredMapId(ids.vouchers, value(doc, "voucherId"), "voucher usage voucher"),
        customerId: optionalMapId(ids.customers, value(doc, "customerId"), "voucher usage customer"),
        orderId: requiredMapId(ids.orders, value(doc, "orderId"), "voucher usage order"),
        discountAppliedPesewas: pesewas(doc, "discountAmount"),
        usedAt: timestampValue(doc, "usedAt", new Date()) ?? new Date(),
      };
    },
    (rows) => insertRows(rows, (values) =>
      db.insert(voucherUsages).values(values).onConflictDoNothing({ target: voucherUsages.legacyConvexId }).returning({ id: voucherUsages.id })
    )
  );
}

const orderByLegacyId = new Map<string, { customerId: string; branchId: string }>();

async function close(): Promise<void> {
  await client.end({ timeout: 5 });
}

main()
  .catch((error: unknown) => {
    console.error("Convex import failed:", error);
    process.exitCode = 1;
  })
  .finally(close);
