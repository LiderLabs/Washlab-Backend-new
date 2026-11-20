import { FastifyInstance, FastifyRequest } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { enrollmentService } from "./enrollment.service.js";

const token = z.string().trim().regex(/^[a-f0-9]{64}$/, "Invalid enrollment token");
const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers["user-agent"] });

/** Public (no station token yet): an invited attendant redeems the link their admin sent. Mounted under /v1/station/enrollment. */
export async function stationEnrollmentRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();
  // Per IP. The token is 256 random bits so guessing is hopeless anyway; this just keeps the endpoint quiet.
  const config = { rateLimit: { max: 20, timeWindow: "1 minute" } };

  server.post(
    "/verify",
    {
      config,
      schema: {
        tags: ["Station enrollment"],
        summary: "Check an enrollment link and show who it is for",
        body: z.object({ token }),
        response: {
          200: z.union([
            z.object({
              valid: z.literal(true),
              attendant: z.object({ id: z.string().uuid(), name: z.string(), email: z.string(), branchId: z.string().uuid(), branchName: z.string() }),
              expiresAt: z.string(),
            }),
            z.object({ valid: z.literal(false), error: z.string() }),
          ]),
        },
      },
    },
    async (request) => enrollmentService.verify(request.body.token)
  );

  server.post(
    "/complete",
    {
      config,
      schema: {
        tags: ["Station enrollment"],
        summary: "Set the 4-digit PIN and activate the attendant",
        body: z.object({ token, pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits") }),
        response: { 200: z.object({ success: z.literal(true), attendantId: z.string().uuid() }) },
      },
    },
    async (request) => enrollmentService.complete(request.body.token, request.body.pin, meta(request))
  );
}
