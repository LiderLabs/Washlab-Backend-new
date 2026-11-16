import { branchRepo, BranchRepo, BranchRow, DbExecutor } from "./repo.js";
import { CreateBranchInput, UpdateBranchInput, BranchDto } from "./schemas.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../platform/errors/index.js";
import { hashSecret } from "../../platform/crypto/index.js";
import { db } from "../../platform/db/index.js";
import { auditLogs } from "../../platform/db/schema/infrastructure.js";
import type { NewBranch } from "../../platform/db/schema/branches.js";

function toBranchDto(b: BranchRow): BranchDto {
  return {
    id: b.id,
    name: b.name,
    code: b.code,
    terminalId: b.terminalId,
    phoneNumber: b.phoneNumber,
    email: b.email,
    address: b.address,
    city: b.city,
    pricingPerKgPesewas: b.pricingPerKgPesewas.toString(),
    deliveryFeePesewas: b.deliveryFeePesewas.toString(),
    requireStationLogin: b.requireStationLogin,
    weeklyOrderTarget: b.weeklyOrderTarget,
    momoNumber: b.momoNumber,
    isActive: b.isActive,
    createdAt: b.createdAt.toISOString(),
  };
}

/** Translate a unique-index violation (Postgres 23505) into a 409. Rethrows anything else. */
function rethrowUniqueViolation(err: unknown): never {
  const e = err as any;
  const code = e?.code ?? e?.cause?.code;
  const constraint = e?.constraint_name ?? e?.cause?.constraint_name;
  if (code === "23505") {
    if (constraint === "idx_branches_terminal_active") {
      throw new ConflictError("A branch with this terminal ID already exists", "BRANCH_TERMINAL_EXISTS");
    }
    throw new ConflictError("A branch with this code already exists", "BRANCH_CODE_EXISTS");
  }
  throw err;
}

type Actor = { id: string; role: string };

async function writeAudit(
  executor: DbExecutor,
  actor: Actor,
  action: string,
  entityId: string,
  changes: Record<string, unknown>
) {
  await executor.insert(auditLogs).values({
    action,
    entityType: "branch",
    entityId,
    performedByUserId: actor.id,
    performedByRole: actor.role,
    changes,
  });
}

// Fields allowed into audit logs. Secrets (PIN) are recorded only as a boolean flag.
const AUDITED_FIELDS = [
  "name", "code", "terminalId", "phoneNumber", "email", "address", "city",
  "pricingPerKgPesewas", "deliveryFeePesewas", "weeklyOrderTarget", "momoNumber",
] as const;

function pickAudited(input: Partial<CreateBranchInput>) {
  const out: Record<string, unknown> = {};
  for (const key of AUDITED_FIELDS) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

export class BranchService {
  constructor(private repo: BranchRepo = branchRepo) { }

  async listActiveBranches() {
    return (await this.repo.listActive()).map(toBranchDto);
  }

  async getBranchById(id: string) {
    const branch = await this.repo.findById(id);
    if (!branch) throw new NotFoundError(`Branch ${id} not found`, "BRANCH_NOT_FOUND");
    return toBranchDto(branch);
  }

  async createBranch(input: CreateBranchInput, actor: Actor) {
    const stationPinHash = await hashSecret(input.stationPin);

    const data: NewBranch = {
      name: input.name,
      code: input.code,
      terminalId: input.terminalId,
      phoneNumber: input.phoneNumber,
      email: input.email,
      address: input.address,
      city: input.city,
      pricingPerKgPesewas: BigInt(input.pricingPerKgPesewas),
      deliveryFeePesewas: BigInt(input.deliveryFeePesewas),
      stationPinHash,
      weeklyOrderTarget: input.weeklyOrderTarget,
      momoNumber: input.momoNumber,
    };

    try {
      const created = await db.transaction(async (tx) => {
        const row = await this.repo.create(data, tx);
        await writeAudit(tx, actor, "branch.created", row.id, pickAudited(input));
        return row;
      });
      return toBranchDto(created);
    } catch (err) {
      rethrowUniqueViolation(err);
    }
  }

  async updateBranch(id: string, input: UpdateBranchInput, actor: Actor) {
    const { stationPin, ...rest } = input;
    const changedFields = pickAudited(rest);
    if (Object.keys(changedFields).length === 0 && !stationPin) {
      throw new BadRequestError("No fields to update", "NO_CHANGES");
    }

    const data: Partial<NewBranch> = {};
    if (rest.name !== undefined) data.name = rest.name;
    if (rest.code !== undefined) data.code = rest.code;
    if (rest.terminalId !== undefined) data.terminalId = rest.terminalId;
    if (rest.phoneNumber !== undefined) data.phoneNumber = rest.phoneNumber;
    if (rest.email !== undefined) data.email = rest.email;
    if (rest.address !== undefined) data.address = rest.address;
    if (rest.city !== undefined) data.city = rest.city;
    if (rest.pricingPerKgPesewas !== undefined) data.pricingPerKgPesewas = BigInt(rest.pricingPerKgPesewas);
    if (rest.deliveryFeePesewas !== undefined) data.deliveryFeePesewas = BigInt(rest.deliveryFeePesewas);
    if (rest.weeklyOrderTarget !== undefined) data.weeklyOrderTarget = rest.weeklyOrderTarget;
    if (rest.momoNumber !== undefined) data.momoNumber = rest.momoNumber;
    if (stationPin) data.stationPinHash = await hashSecret(stationPin);

    try {
      const updated = await db.transaction(async (tx) => {
        const row = await this.repo.update(id, data, tx);
        if (!row) throw new NotFoundError(`Branch ${id} not found`, "BRANCH_NOT_FOUND");
        await writeAudit(tx, actor, "branch.updated", id, {
          ...changedFields,
          stationPinChanged: Boolean(stationPin),
        });
        return row;
      });
      return toBranchDto(updated);
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      rethrowUniqueViolation(err);
    }
  }

  async deleteBranch(id: string, actor: Actor) {
    await db.transaction(async (tx) => {
      const deleted = await this.repo.softDelete(id, tx);
      if (!deleted) throw new NotFoundError(`Branch ${id} not found`, "BRANCH_NOT_FOUND");
      await writeAudit(tx, actor, "branch.deleted", id, { deleted: true });
    });
    return { success: true };
  }
}

export const branchService = new BranchService();