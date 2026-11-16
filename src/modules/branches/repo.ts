import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { branches, NewBranch } from "../../platform/db/schema/branches.js";


type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DbExecutor = typeof db | Tx;


// The ONLY columns that ever leave this repo. stationPinHash is deliberately absent.
const branchColumns = {
  id: branches.id,
  name: branches.name,
  code: branches.code,
  terminalId: branches.terminalId,
  phoneNumber: branches.phoneNumber,
  email: branches.email,
  address: branches.address,
  city: branches.city,
  pricingPerKgPesewas: branches.pricingPerKgPesewas,
  deliveryFeePesewas: branches.deliveryFeePesewas,
  requireStationLogin: branches.requireStationLogin,
  weeklyOrderTarget: branches.weeklyOrderTarget,
  momoNumber: branches.momoNumber,
  isActive: branches.isActive,
  createdAt: branches.createdAt,
};


// Let TypeScript infer the exact row shape returned by this query.
const branchQuery = (executor: DbExecutor = db) =>
  executor.select(branchColumns).from(branches);


export type BranchRow = Awaited<ReturnType<typeof branchQuery>>[number];


export class BranchRepo {
  async listActive(): Promise<BranchRow[]> {
    const rows = await branchQuery().where(
      and(isNull(branches.deletedAt), eq(branches.isActive, true))
    );

    return rows;
  }


  async findById(id: string, executor: DbExecutor = db): Promise<BranchRow | null> {
    const rows = await branchQuery(executor)
      .where(and(eq(branches.id, id), isNull(branches.deletedAt)))
      .limit(1);

    return rows[0] ?? null;
  }


  async create(data: NewBranch, executor: DbExecutor = db): Promise<BranchRow> {
    const rows = await executor
      .insert(branches)
      .values(data)
      .returning(branchColumns);

    return rows[0];
  }


  async update(
    id: string,
    data: Partial<NewBranch>,
    executor: DbExecutor = db
  ): Promise<BranchRow | null> {
    const rows = await executor
      .update(branches)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(branches.id, id), isNull(branches.deletedAt)))
      .returning(branchColumns);

    return rows[0] ?? null;
  }


  async softDelete(id: string, executor: DbExecutor = db): Promise<boolean> {
    const rows = await executor
      .update(branches)
      .set({
        deletedAt: new Date(),
        isActive: false,
        updatedAt: new Date(),
      })
      .where(and(eq(branches.id, id), isNull(branches.deletedAt)))
      .returning({ id: branches.id });

    return rows.length > 0;
  }
}


export const branchRepo = new BranchRepo();