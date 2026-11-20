import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { catalogService } from "./service.js";

export async function catalogRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const paginationQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });

  // Public: List all active services (Convex services.getActive equivalent)
  server.get(
    "/",
    {
      schema: {
        tags: ["Catalog"],
        summary: "Get all active services for public/customer access",
        querystring: paginationQuery,
      },
    },
    async (request, reply) => {
      const result = await catalogService.getActiveServices(request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  // Public: Get services for a specific branch (Convex admin.getBranchServicesForCustomer equivalent)
  server.get(
    "/branch/:branchId",
    {
      schema: {
        tags: ["Catalog"],
        summary: "Get active services configured for a specific branch",
        params: z.object({
          branchId: z.string().uuid(),
        }),
        querystring: paginationQuery,
      },
    },
    async (request, reply) => {
      const result = await catalogService.getBranchServices(request.params.branchId, request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );
}
