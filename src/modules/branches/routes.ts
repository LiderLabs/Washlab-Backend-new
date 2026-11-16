import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { branchService } from "./service.js";
import { branchDtoSchema, createBranchInputSchema, updateBranchInputSchema } from "./schemas.js";
import { authenticate, requirePermission } from "../../platform/auth/index.js";

export async function branchRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // List active branches (public)
  server.get(
    "/",
    {
      schema: {
        tags: ["Branches"],
        summary: "List all active branches",
        response: { 200: z.array(branchDtoSchema) },
      },
    },
    async () => branchService.listActiveBranches()
  );

  // Get one branch (public, safe DTO)
  server.get(
    "/:id",
    {
      schema: {
        tags: ["Branches"],
        summary: "Get branch details by ID",
        params: z.object({ id: z.string().uuid() }),
        response: { 200: branchDtoSchema },
      },
    },
    async (request) => branchService.getBranchById(request.params.id)
  );

  // Create branch
  server.post(
    "/",
    {
      onRequest: [authenticate, requirePermission("branch.create")],
      schema: {
        tags: ["Branches"],
        summary: "Create a new branch",
        security: [{ bearerAuth: [] }],
        body: createBranchInputSchema,
        response: { 201: branchDtoSchema },
      },
    },
    async (request, reply) => {
      const user = request.user!;
      const branch = await branchService.createBranch(request.body, { id: user.id, role: user.role });
      return reply.status(201).send(branch);
    }
  );

  // Update branch
  server.patch(
    "/:id",
    {
      onRequest: [authenticate, requirePermission("branch.update")],
      schema: {
        tags: ["Branches"],
        summary: "Update a branch (send only the fields that change)",
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        body: updateBranchInputSchema,
        response: { 200: branchDtoSchema },
      },
    },
    async (request) => {
      const user = request.user!;
      return branchService.updateBranch(request.params.id, request.body, { id: user.id, role: user.role });
    }
  );

  // Soft delete branch
  server.delete(
    "/:id",
    {
      onRequest: [authenticate, requirePermission("branch.delete")],
      schema: {
        tags: ["Branches"],
        summary: "Delete a branch",
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ success: z.boolean() }) },
      },
    },
    async (request) => {
      const user = request.user!;
      return branchService.deleteBranch(request.params.id, { id: user.id, role: user.role });
    }
  );
}