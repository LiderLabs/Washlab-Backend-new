import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticate } from "../../platform/auth/index.js";

export async function orderRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/",
    {
      preHandler: [authenticate],
      schema: {
        tags: ["Orders"],
        summary: "List orders with keyset pagination",
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          branchId: z.string().uuid().optional(),
          status: z.string().optional(),
          limit: z.coerce.number().min(1).max(100).default(20),
          cursor: z.string().optional(),
        }),
      },
    },
    async (request) => {
      return {
        items: [],
        nextCursor: null,
        limit: request.query.limit,
      };
    }
  );
}
