import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branchServices } from "../../platform/db/schema/catalog.js";
import { dailyReports, type DailyReport } from "../../platform/db/schema/reports.js";
import { writeAudit } from "../../platform/audit/index.js";
import { BadRequestError, ConflictError } from "../../platform/errors/index.js";
import type { StationContext } from "../../platform/auth/station.js";
import { stationService } from "../station/service.js";
import { computeAutoReport, todayUtc, FALLBACK_UNIT_PRICE_PESEWAS } from "./compute.js";
import type { SaveDraftInput, SubmitReportInput } from "../station/reports.schemas.js";

type RequestMeta = { ip?: string; userAgent?: string };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function resolveDate(date?: string) {
  const d = date ?? todayUtc();
  if (d > todayUtc()) throw new BadRequestError("A report can't be for a future date", "REPORT_DATE_IN_FUTURE");
  return d;
}

export function toReportDto(r: DailyReport) {
  return {
    id: r.id,
    branchId: r.branchId,
    attendantId: r.attendantId,
    date: r.reportDate,
    status: r.status,
    attendantsOnShift: r.attendantsOnShift,
    washerTokensUsed: r.washerTokensUsed,
    dryerTokensUsed: r.dryerTokensUsed,
    totalTokensUsed: r.totalTokensUsed,
    serviceBreakdown: r.serviceBreakdown,
    voucherBreakdown: r.voucherBreakdown,
    cashPesewas: r.cashPesewas,
    mobileMoneyPesewas: r.mobileMoneyPesewas,
    cardPesewas: r.cardPesewas,
    totalRevenuePesewas: r.totalRevenuePesewas,
    soapUnitsUsed: r.soapUnitsUsed,
    freeWashCount: r.freeWashCount,
    washingPlanCount: r.washingPlanCount,
    technicalFaultCount: r.technicalFaultCount,
    technicalFaultNotes: r.technicalFaultNotes,
    outstandingAmountPesewas: r.outstandingAmountPesewas,
    outstandingOrderCount: r.outstandingOrderCount,
    outstandingRecoveredPesewas: r.outstandingRecoveredPesewas,
    notes: r.notes,
    submittedAt: r.submittedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function getAuto(station: StationContext, date?: string) {
  return computeAutoReport(station.branchId, resolveDate(date));
}

async function getDraft(station: StationContext, date?: string) {
  const [row] = await db
    .select()
    .from(dailyReports)
    .where(and(eq(dailyReports.branchId, station.branchId), eq(dailyReports.reportDate, resolveDate(date))))
    .limit(1);
  return row ? toReportDto(row) : null;
}

async function list(station: StationContext, q: { startDate?: string; endDate?: string; limit: number; offset: number }) {
  const conds = [eq(dailyReports.branchId, station.branchId)];
  if (q.startDate) conds.push(gte(dailyReports.reportDate, q.startDate));
  if (q.endDate) conds.push(lte(dailyReports.reportDate, q.endDate));
  const condition = and(...conds);
  const [rows, countRows] = await Promise.all([
    db
    .select()
    .from(dailyReports)
    .where(condition)
    .orderBy(desc(dailyReports.reportDate))
    .limit(q.limit)
    .offset(q.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(dailyReports).where(condition),
  ]);

  const prices = await db
    .select({ code: branchServices.code, price: branchServices.pricePesewas })
    .from(branchServices)
    .where(and(eq(branchServices.branchId, station.branchId), sql`${branchServices.deletedAt} IS NULL`));
  const washer = Number(prices.find((p) => p.code === "wash_only")?.price ?? FALLBACK_UNIT_PRICE_PESEWAS);
  const dryer = Number(prices.find((p) => p.code === "dry_only")?.price ?? FALLBACK_UNIT_PRICE_PESEWAS);
  return {
    items: rows.map((r) => ({ ...toReportDto(r), washerPricePesewas: washer, dryerPricePesewas: dryer })),
    total: countRows[0]?.count ?? 0,
  };
}

type Manual = Omit<SaveDraftInput, "attendantId">;

/** Builds the row values: the server's figures for everything that is money, plus the attendant's own entries. */
async function buildValues(branchId: string, date: string, manual: Manual) {
  const auto = await computeAutoReport(branchId, date);
  const washer = manual.washerTokensUsed ?? auto.washerTokensUsed;
  const dryer = manual.dryerTokensUsed ?? auto.dryerTokensUsed;
  return {
    auto,
    values: {
      attendantsOnShift: manual.attendantsOnShift ?? auto.todayAttendantNames,
      washerTokensUsed: washer,
      dryerTokensUsed: dryer,
      totalTokensUsed: washer + dryer,
      serviceBreakdown: auto.serviceBreakdown,
      voucherBreakdown: auto.voucherBreakdown,
      cashPesewas: auto.cashPesewas,
      mobileMoneyPesewas: auto.mobileMoneyPesewas,
      cardPesewas: auto.cardPesewas,
      totalRevenuePesewas: auto.totalRevenuePesewas,
      soapUnitsUsed: manual.soapUnitsUsed ?? 0,
      freeWashCount: auto.freeWashCount,
      washingPlanCount: manual.washingPlanCount ?? 0,
      technicalFaultCount: manual.technicalFaultCount ?? 0,
      technicalFaultNotes: manual.technicalFaultNotes ?? null,
      outstandingAmountPesewas: auto.outstandingAmountPesewas,
      outstandingOrderCount: auto.outstandingOrderCount,
      outstandingRecoveredPesewas: auto.outstandingRecoveredPesewas,
      notes: manual.notes ?? null,
    },
  };
}

/** One writer per branch+day, so two tablets saving at once can't interleave. */
async function lockReport(tx: Tx, branchId: string, date: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`daily_report:${branchId}:${date}`}, 0))`);
}

async function saveDraft(station: StationContext, input: SaveDraftInput) {
  const date = resolveDate(input.date);
  const { values } = await buildValues(station.branchId, date, input);

  const row = await db.transaction(async (tx) => {
    await lockReport(tx, station.branchId, date);
    const [existing] = await tx
      .select()
      .from(dailyReports)
      .where(and(eq(dailyReports.branchId, station.branchId), eq(dailyReports.reportDate, date)))
      .limit(1);

    // A submitted report is never turned back into a draft.
    if (existing && existing.status !== "draft") return existing;

    if (existing) {
      const [updated] = await tx
        .update(dailyReports)
        .set({ ...values, attendantId: input.attendantId ?? existing.attendantId, updatedAt: new Date() })
        .where(eq(dailyReports.id, existing.id))
        .returning();
      return updated!;
    }
    const [created] = await tx
      .insert(dailyReports)
      .values({ branchId: station.branchId, reportDate: date, attendantId: input.attendantId, status: "draft", ...values })
      .returning();
    return created!;
  });
  return toReportDto(row);
}

async function submit(station: StationContext, input: SubmitReportInput, meta: RequestMeta) {
  const date = resolveDate(input.date);
  // PIN first and outside the transaction, so a wrong PIN still counts toward the lockout.
  const { attendant } = await stationService.verifyActionPin(station, { attendantId: input.attendantId, pin: input.pin });
  const { auto, values } = await buildValues(station.branchId, date, input);
  const status = values.outstandingOrderCount > 0 ? "submitted_with_outstanding" : "submitted";

  const row = await db.transaction(async (tx) => {
    await lockReport(tx, station.branchId, date);
    const [existing] = await tx
      .select()
      .from(dailyReports)
      .where(and(eq(dailyReports.branchId, station.branchId), eq(dailyReports.reportDate, date)))
      .limit(1);

    // A report that went in with outstanding orders can be sent again once they are settled. A clean one can't.
    if (existing?.status === "submitted") {
      throw new ConflictError("Report already submitted for this date", "REPORT_ALREADY_SUBMITTED");
    }

    const now = new Date();
    const saved = existing
      ? (
          await tx
            .update(dailyReports)
            .set({ ...values, status, attendantId: attendant.id, submittedAt: now, updatedAt: now })
            .where(eq(dailyReports.id, existing.id))
            .returning()
        )[0]!
      : (
          await tx
            .insert(dailyReports)
            .values({ branchId: station.branchId, reportDate: date, attendantId: attendant.id, status, submittedAt: now, ...values })
            .returning()
        )[0]!;

    await writeAudit(tx, {
      actorId: attendant.id,
      actorRole: "attendant",
      action: "daily_report.submitted",
      entityType: "daily_report",
      entityId: saved.id,
      changes: {
        branchId: station.branchId,
        date,
        status,
        totalTokensUsed: values.totalTokensUsed,
        autoTokensUsed: auto.washerTokensUsed + auto.dryerTokensUsed,
        totalRevenuePesewas: values.totalRevenuePesewas,
        outstandingOrderCount: values.outstandingOrderCount,
      },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return saved;
  });
  return toReportDto(row);
}

export const reportsService = { getAuto, getDraft, list, saveDraft, submit };
