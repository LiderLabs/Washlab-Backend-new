import { FastifyInstance, FastifyRequest } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { authenticateStation, requireStation, STATION_TOKEN_HEADER } from "../../platform/auth/station.js";
import { reportsService } from "../reports/service.js";
import { reportDateQuery, reportListQuery, saveDraftBody, submitReportBody } from "./reports.schemas.js";

const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers["user-agent"] });
const security = [{ stationToken: [] }];
const tags = ["Station reports"];
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

/** End-of-day report page. Mounted under /v1/station/reports. Money is whole pesewas (numbers). */
export async function stationReportRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/auto",
    { ...base, schema: { tags, summary: "The day's figures, calculated from orders and payments", security, querystring: reportDateQuery } },
    async (request) => reportsService.getAuto(requireStation(request), request.query.date)
  );

  server.get(
    "/draft",
    { ...base, schema: { tags, summary: "The saved report (draft or submitted) for a day, or null", security, querystring: reportDateQuery } },
    async (request) => reportsService.getDraft(requireStation(request), request.query.date)
  );

  server.get(
    "/",
    { ...base, schema: { tags, summary: "Past reports for this branch, newest first", security, querystring: reportListQuery } },
    async (request) => reportsService.list(requireStation(request), request.query)
  );

  server.put(
    "/draft",
    { ...base, schema: { tags, summary: "Save the report as a draft", security, body: saveDraftBody } },
    async (request) => reportsService.saveDraft(requireStation(request), request.body)
  );

  server.post(
    "/submit",
    { ...base, schema: { tags, summary: "Submit the day's report (attendant PIN required)", security, body: submitReportBody } },
    async (request) => reportsService.submit(requireStation(request), request.body, meta(request))
  );
}
