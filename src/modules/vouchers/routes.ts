import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { voucherService } from "./service.js";

export async function voucherRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // Public voucher validation for customer checkout
  server.get(
    "/validate",
    {
      schema: {
        tags: ["Vouchers"],
        summary: "Validate promo/voucher code for customer order checkout",
        querystring: z.object({
          code: z.string().trim().min(1),
          branchId: z.string().optional(),
          orderTotal: z.coerce.number().optional(),
          serviceType: z.string().optional(),
        }),
      },
    },
    async (request) => {
      return voucherService.validateVoucher(request.query);
    }
  );

  server.post(
    "/validate",
    {
      schema: {
        tags: ["Vouchers"],
        summary: "Validate promo/voucher code for customer order checkout (POST)",
        body: z.object({
          code: z.string().trim().min(1),
          branchId: z.string().optional(),
          orderTotal: z.number().optional(),
          serviceType: z.string().optional(),
        }),
      },
    },
    async (request) => {
      return voucherService.validateVoucher(request.body);
    }
  );
}
