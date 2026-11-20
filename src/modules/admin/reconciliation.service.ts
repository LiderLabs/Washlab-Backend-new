import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branches } from "../../platform/db/schema/branches.js";
import { cashDeductions, cashLedger, cashReconTransactions } from "../../platform/db/schema/cash.js";
import { dailyReports } from "../../platform/db/schema/reports.js";
import { attendants } from "../../platform/db/schema/staff.js";
import { NotFoundError } from "../../platform/errors/index.js";

export const adminReconciliationService = {
  async getBranchCashSummaries(sinceTs?: number, untilTs?: number) {
    const branchList = await db
      .select({
        id: branches.id,
        name: branches.name,
        code: branches.code,
        terminalId: branches.terminalId,
      })
      .from(branches)
      .where(and(isNull(branches.deletedAt), eq(branches.isActive, true)))
      .orderBy(asc(branches.name));

    if (branchList.length === 0) return [];

    const ledgerRows = await db
      .select({
        branchId: cashLedger.branchId,
        collected: sql<string>`sum(${cashLedger.collected})::text`,
        sent: sql<string>`sum(${cashLedger.sent})::text`,
        deducted: sql<string>`sum(${cashLedger.deducted})::text`,
        creditApplied: sql<string>`sum(${cashLedger.creditApplied})::text`,
        outstanding: sql<string>`sum(${cashLedger.outstanding})::text`,
      })
      .from(cashLedger)
      .groupBy(cashLedger.branchId);

    const ledgerMap = new Map(ledgerRows.map((l) => [l.branchId, l]));

    return branchList.map((b) => {
      const row = ledgerMap.get(b.id);
      const collectedPesewas = row ? BigInt(row.collected || 0) : 0n;
      const sentPesewas = row ? BigInt(row.sent || 0) : 0n;
      const deductedPesewas = row ? BigInt(row.deducted || 0) : 0n;
      const creditAppliedPesewas = row ? BigInt(row.creditApplied || 0) : 0n;
      const outstandingPesewas = row ? BigInt(row.outstanding || 0) : 0n;

      return {
        branchId: b.id,
        branchName: b.name,
        code: b.code,
        terminalId: b.terminalId,
        collectedGhs: Number(collectedPesewas) / 100,
        sentGhs: Number(sentPesewas) / 100,
        deductedGhs: Number(deductedPesewas) / 100,
        creditAppliedGhs: Number(creditAppliedPesewas) / 100,
        outstandingGhs: Number(outstandingPesewas) / 100,
        collectedPesewas: collectedPesewas.toString(),
        sentPesewas: sentPesewas.toString(),
        deductedPesewas: deductedPesewas.toString(),
        outstandingPesewas: outstandingPesewas.toString(),
      };
    });
  },

  async getAllReconciliations(query?: { limit?: number; offset?: number }) {
    const [rows, countRows] = await Promise.all([
      db
      .select({
        id: cashReconTransactions.id,
        branchId: cashReconTransactions.branchId,
        branchName: branches.name,
        attendantId: cashReconTransactions.attendantId,
        attendantName: attendants.name,
        paystackReference: cashReconTransactions.paystackReference,
        paystackTransactionId: cashReconTransactions.paystackTransactionId,
        amountSentPesewas: cashReconTransactions.amountSentPesewas,
        senderMomoNumber: cashReconTransactions.senderMomoNumber,
        network: cashReconTransactions.network,
        status: cashReconTransactions.status,
        excessPesewas: cashReconTransactions.excessPesewas,
        displayText: cashReconTransactions.displayText,
        notes: cashReconTransactions.notes,
        createdAt: cashReconTransactions.createdAt,
        completedAt: cashReconTransactions.completedAt,
      })
      .from(cashReconTransactions)
      .leftJoin(branches, eq(cashReconTransactions.branchId, branches.id))
      .leftJoin(attendants, eq(cashReconTransactions.attendantId, attendants.id))
      .orderBy(desc(cashReconTransactions.createdAt))
      .limit(query?.limit ?? 50)
      .offset(query?.offset ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(cashReconTransactions),
    ]);

    return { items: rows.map((r) => ({
      id: r.id,
      _id: r.id,
      branchId: r.branchId,
      branchName: r.branchName ?? "Unknown Branch",
      attendantId: r.attendantId,
      attendantName: r.attendantName ?? "Unknown Attendant",
      paystackReference: r.paystackReference,
      paystackTransactionId: r.paystackTransactionId,
      amountSentGhs: Number(r.amountSentPesewas) / 100,
      amountSentPesewas: r.amountSentPesewas.toString(),
      senderMomoNumber: r.senderMomoNumber,
      network: r.network,
      status: r.status,
      excessGhs: Number(r.excessPesewas) / 100,
      excessPesewas: r.excessPesewas.toString(),
      displayText: r.displayText,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    })), total: countRows[0]?.count ?? 0 };
  },

  async getAllDeductions(query?: { limit?: number; offset?: number }) {
    const conditions = [isNull(cashDeductions.deletedAt)];
    const [rows, countRows] = await Promise.all([
      db
      .select({
        id: cashDeductions.id,
        branchId: cashDeductions.branchId,
        branchName: branches.name,
        attendantId: cashDeductions.attendantId,
        attendantName: attendants.name,
        amountPesewas: cashDeductions.amountPesewas,
        reason: cashDeductions.reason,
        day: cashDeductions.day,
        createdAt: cashDeductions.createdAt,
      })
      .from(cashDeductions)
      .leftJoin(branches, eq(cashDeductions.branchId, branches.id))
      .leftJoin(attendants, eq(cashDeductions.attendantId, attendants.id))
      .where(and(...conditions))
      .orderBy(desc(cashDeductions.createdAt))
      .limit(query?.limit ?? 50)
      .offset(query?.offset ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(cashDeductions).where(and(...conditions)),
    ]);

    return { items: rows.map((r) => ({
      id: r.id,
      _id: r.id,
      branchId: r.branchId,
      branchName: r.branchName ?? "Unknown Branch",
      attendantId: r.attendantId,
      attendantName: r.attendantName ?? "Unknown Attendant",
      amountGhs: Number(r.amountPesewas) / 100,
      amountPesewas: r.amountPesewas.toString(),
      reason: r.reason,
      day: r.day,
      createdAt: r.createdAt.toISOString(),
    })), total: countRows[0]?.count ?? 0 };
  },

  async getAllDailyReports(query?: { branchId?: string; startDate?: string; endDate?: string; limit?: number; offset?: number }) {
    const conditions = [];

    if (query?.branchId) {
      conditions.push(eq(dailyReports.branchId, query.branchId));
    }

    if (query?.startDate) {
      conditions.push(gte(dailyReports.reportDate, query.startDate));
    }

    if (query?.endDate) {
      conditions.push(lte(dailyReports.reportDate, query.endDate));
    }

    const condition = conditions.length > 0 ? and(...conditions) : undefined;
    const [rows, countRows] = await Promise.all([
      db
      .select({
        id: dailyReports.id,
        branchId: dailyReports.branchId,
        branchName: branches.name,
        attendantId: dailyReports.attendantId,
        attendantName: attendants.name,
        reportDate: dailyReports.reportDate,
        attendantsOnShift: dailyReports.attendantsOnShift,
        washerTokensUsed: dailyReports.washerTokensUsed,
        dryerTokensUsed: dailyReports.dryerTokensUsed,
        totalTokensUsed: dailyReports.totalTokensUsed,
        serviceBreakdown: dailyReports.serviceBreakdown,
        voucherBreakdown: dailyReports.voucherBreakdown,
        cashPesewas: dailyReports.cashPesewas,
        mobileMoneyPesewas: dailyReports.mobileMoneyPesewas,
        cardPesewas: dailyReports.cardPesewas,
        totalRevenuePesewas: dailyReports.totalRevenuePesewas,
        soapUnitsUsed: dailyReports.soapUnitsUsed,
        freeWashCount: dailyReports.freeWashCount,
        technicalFaultCount: dailyReports.technicalFaultCount,
        technicalFaultNotes: dailyReports.technicalFaultNotes,
        outstandingAmountPesewas: dailyReports.outstandingAmountPesewas,
        outstandingOrderCount: dailyReports.outstandingOrderCount,
        status: dailyReports.status,
        submittedAt: dailyReports.submittedAt,
        notes: dailyReports.notes,
        createdAt: dailyReports.createdAt,
      })
      .from(dailyReports)
      .leftJoin(branches, eq(dailyReports.branchId, branches.id))
      .leftJoin(attendants, eq(dailyReports.attendantId, attendants.id))
      .where(condition)
      .orderBy(desc(dailyReports.reportDate))
      .limit(query?.limit ?? 50)
      .offset(query?.offset ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(dailyReports).where(condition),
    ]);

    return { items: rows.map((r) => ({
      id: r.id,
      _id: r.id,
      branchId: r.branchId,
      branchName: r.branchName ?? "Unknown Branch",
      attendantId: r.attendantId,
      attendantName: r.attendantName ?? "Unknown Attendant",
      reportDate: r.reportDate,
      attendantsOnShift: r.attendantsOnShift,
      washerTokensUsed: r.washerTokensUsed,
      dryerTokensUsed: r.dryerTokensUsed,
      totalTokensUsed: r.totalTokensUsed,
      serviceBreakdown: r.serviceBreakdown,
      voucherBreakdown: r.voucherBreakdown,
      cashGhs: Number(r.cashPesewas) / 100,
      mobileMoneyGhs: Number(r.mobileMoneyPesewas) / 100,
      cardGhs: Number(r.cardPesewas) / 100,
      totalRevenueGhs: Number(r.totalRevenuePesewas) / 100,
      cashPesewas: r.cashPesewas.toString(),
      totalRevenuePesewas: r.totalRevenuePesewas.toString(),
      soapUnitsUsed: r.soapUnitsUsed,
      freeWashCount: r.freeWashCount,
      technicalFaultCount: r.technicalFaultCount,
      technicalFaultNotes: r.technicalFaultNotes,
      outstandingAmountGhs: Number(r.outstandingAmountPesewas) / 100,
      outstandingAmountPesewas: r.outstandingAmountPesewas.toString(),
      outstandingOrderCount: r.outstandingOrderCount,
      status: r.status,
      submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
    })), total: countRows[0]?.count ?? 0 };
  },

  async getDailyReportById(id: string) {
    const [report] = await db
      .select({
        id: dailyReports.id,
        branchId: dailyReports.branchId,
        branchName: branches.name,
        attendantId: dailyReports.attendantId,
        attendantName: attendants.name,
        reportDate: dailyReports.reportDate,
        attendantsOnShift: dailyReports.attendantsOnShift,
        washerTokensUsed: dailyReports.washerTokensUsed,
        dryerTokensUsed: dailyReports.dryerTokensUsed,
        totalTokensUsed: dailyReports.totalTokensUsed,
        serviceBreakdown: dailyReports.serviceBreakdown,
        voucherBreakdown: dailyReports.voucherBreakdown,
        cashPesewas: dailyReports.cashPesewas,
        mobileMoneyPesewas: dailyReports.mobileMoneyPesewas,
        cardPesewas: dailyReports.cardPesewas,
        totalRevenuePesewas: dailyReports.totalRevenuePesewas,
        soapUnitsUsed: dailyReports.soapUnitsUsed,
        freeWashCount: dailyReports.freeWashCount,
        technicalFaultCount: dailyReports.technicalFaultCount,
        technicalFaultNotes: dailyReports.technicalFaultNotes,
        outstandingAmountPesewas: dailyReports.outstandingAmountPesewas,
        outstandingOrderCount: dailyReports.outstandingOrderCount,
        status: dailyReports.status,
        submittedAt: dailyReports.submittedAt,
        notes: dailyReports.notes,
        createdAt: dailyReports.createdAt,
      })
      .from(dailyReports)
      .leftJoin(branches, eq(dailyReports.branchId, branches.id))
      .leftJoin(attendants, eq(dailyReports.attendantId, attendants.id))
      .where(eq(dailyReports.id, id))
      .limit(1);

    if (!report) throw new NotFoundError("Daily report not found", "DAILY_REPORT_NOT_FOUND");

    return {
      id: report.id,
      _id: report.id,
      branchId: report.branchId,
      branchName: report.branchName ?? "Unknown Branch",
      attendantId: report.attendantId,
      attendantName: report.attendantName ?? "Unknown Attendant",
      reportDate: report.reportDate,
      attendantsOnShift: report.attendantsOnShift,
      washerTokensUsed: report.washerTokensUsed,
      dryerTokensUsed: report.dryerTokensUsed,
      totalTokensUsed: report.totalTokensUsed,
      serviceBreakdown: report.serviceBreakdown,
      voucherBreakdown: report.voucherBreakdown,
      cashGhs: Number(report.cashPesewas) / 100,
      mobileMoneyGhs: Number(report.mobileMoneyPesewas) / 100,
      cardGhs: Number(report.cardPesewas) / 100,
      totalRevenueGhs: Number(report.totalRevenuePesewas) / 100,
      soapUnitsUsed: report.soapUnitsUsed,
      freeWashCount: report.freeWashCount,
      technicalFaultCount: report.technicalFaultCount,
      technicalFaultNotes: report.technicalFaultNotes,
      outstandingAmountGhs: Number(report.outstandingAmountPesewas) / 100,
      outstandingOrderCount: report.outstandingOrderCount,
      status: report.status,
      submittedAt: report.submittedAt ? report.submittedAt.toISOString() : null,
      notes: report.notes,
      createdAt: report.createdAt.toISOString(),
    };
  },
};
