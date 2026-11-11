import { FastifyRequest } from "fastify";
import { verifyToken } from "@clerk/backend";
import { and, eq, isNull } from "drizzle-orm";
import { config } from "../config/index.js";
import { db } from "../db/index.js";
import { admins, attendants } from "../db/schema/staff.js";
import { UnauthorizedError, ForbiddenError } from "../errors/index.js";
import { can, Permission, Role } from "./permissions.js";

export type { Permission, Role } from "./permissions.js";

export type AuthenticatedUser = {
  id: string; // Clerk user ID
  role: Role;
  staffId?: string; // admins.id or attendants.id
  branchId?: string; // attendants only
};

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

async function resolveUser(clerkUserId: string): Promise<AuthenticatedUser> {
  const [admin] = await db
    .select({ id: admins.id, role: admins.role })
    .from(admins)
    .where(and(eq(admins.clerkUserId, clerkUserId), isNull(admins.deletedAt)))
    .limit(1);

  if (admin) {
    return { id: clerkUserId, role: admin.role, staffId: admin.id };
  }

  const [attendant] = await db
    .select({
      id: attendants.id,
      branchId: attendants.branchId,
      status: attendants.status,
      lockedUntil: attendants.lockedUntil,
    })
    .from(attendants)
    .where(and(eq(attendants.clerkUserId, clerkUserId), isNull(attendants.deletedAt)))
    .limit(1);

  if (attendant) {
    if (attendant.status !== "active") {
      throw new ForbiddenError("This account is not active", "ACCOUNT_INACTIVE");
    }
    if (attendant.lockedUntil && attendant.lockedUntil > new Date()) {
      throw new ForbiddenError("This account is temporarily locked", "ACCOUNT_LOCKED");
    }
    return {
      id: clerkUserId,
      role: "attendant",
      staffId: attendant.id,
      branchId: attendant.branchId,
    };
  }

  // Not staff: treated as a customer. Drivers get their own lookup when that module is built.
  return { id: clerkUserId, role: "customer" };
}

/** preHandler: verifies the Clerk JWT, then loads role and status from the database. */
export async function authenticate(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing or invalid authorization header");
  }
  const token = header.slice(7).trim();

  let clerkUserId: string;
  try {
    // Handles both return shapes across @clerk/backend versions
    const result: any = await verifyToken(token, { secretKey: config.CLERK_SECRET_KEY });
    const payload = result?.data ?? result;
    if (result?.errors?.length || !payload?.sub) {
      throw new Error("token rejected");
    }
    clerkUserId = payload.sub as string;
  } catch (err) {
    request.log.warn({ reason: (err as Error).message }, "Token verification failed");
    throw new UnauthorizedError("Invalid or expired authentication token");
  }

  request.user = await resolveUser(clerkUserId);
}

export function requireRole(...allowedRoles: Role[]) {
  return async (request: FastifyRequest) => {
    if (!request.user) throw new UnauthorizedError("User is not authenticated");
    if (!allowedRoles.includes(request.user.role)) {
      throw new ForbiddenError("You do not have access to this resource");
    }
  };
}

export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest) => {
    if (!request.user) throw new UnauthorizedError("User is not authenticated");
    if (!can(request.user.role, permission)) {
      throw new ForbiddenError(`Missing permission: ${permission}`, "MISSING_PERMISSION");
    }
  };
}

/** Attendants may only touch their own branch. Call this in services or routes that take a branchId. */
export function assertBranchAccess(user: AuthenticatedUser, branchId: string) {
  if (user.role === "super_admin" || user.role === "admin") return;
  if (user.role === "attendant" && user.branchId === branchId) return;
  throw new ForbiddenError("You do not have access to this branch", "BRANCH_ACCESS_DENIED");
}