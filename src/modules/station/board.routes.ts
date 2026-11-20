import { FastifyInstance, FastifyRequest } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticateStation, requireStation, STATION_TOKEN_HEADER } from "../../platform/auth/station.js";
import { boardService } from "./board.service.js";
import { noticeListQuery, noticeSchema, reportFaultBody, ticketListQuery, ticketSchema } from "./board.schemas.js";

const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers["user-agent"] });
const security = [{ stationToken: [] }];
const base = {
  onRequest: [authenticateStation],
  config: {
    rateLimit: {
      max: 120,
      timeWindow: "1 minute",
      keyGenerator: (req: FastifyRequest) => String(req.headers[STATION_TOKEN_HEADER] ?? req.ip),
    },
  },
};

/** Machine faults and branch notices. Mounted under /v1/station. */
export async function stationBoardRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    "/maintenance",
    {
      ...base,
      schema: {
        tags: ["Station maintenance"],
        summary: "Report a machine fault",
        security,
        body: reportFaultBody,
        response: { 200: ticketSchema.extend({ duplicate: z.boolean() }) },
      },
    },
    async (request) => boardService.reportFault(requireStation(request), request.body, meta(request))
  );

  server.get(
    "/maintenance",
    {
      ...base,
      schema: {
        tags: ["Station maintenance"],
        summary: "Fault tickets for this branch, newest first",
        security,
        querystring: ticketListQuery,
        response: { 200: z.array(ticketSchema) },
      },
    },
    async (request, reply) => {
      const result = await boardService.listTickets(requireStation(request), request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );

  server.get(
    "/notices",
    {
      ...base,
      schema: {
        tags: ["Station notices"],
        summary: "Active notices for this branch (global and branch-specific, not expired)",
        security,
        querystring: noticeListQuery,
        response: { 200: z.array(noticeSchema) },
      },
    },
    async (request, reply) => {
      const result = await boardService.activeNotices(requireStation(request), request.query);
      reply.header("X-Total-Count", result.total);
      return result.items;
    }
  );
}
