import { FastifyInstance, FastifyRequest } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticateStation, requireStation, STATION_TOKEN_HEADER } from "../../platform/auth/station.js";
import { cashService } from "../cash/recon.service.js";
import {
  deductionBody,
  historyQuery,
  initiateReconBody,
  otpBody,
  referenceParams,
  summaryResponse,
} from "./cash.schemas.js";

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
const tags = ["Station cash"];

/** Cash reconciliation page. Mounted under /v1/station/cash. Money is whole pesewas (numbers). */
export async function stationCashRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    "/summary",
    { ...base, schema: { tags, summary: "Today's cash and everything still owed", security, response: { 200: summaryResponse } } },
    async (request) => cashService.summary(requireStation(request))
  );

  server.get(
    "/orders",
    { ...base, schema: { tags, summary: "Cash orders paid today", security } },
    async (request) => cashService.todayCashOrders(requireStation(request))
  );

  server.get(
    "/deductions",
    { ...base, schema: { tags, summary: "Cash deductions made today", security } },
    async (request) => cashService.todayDeductions(requireStation(request))
  );

  server.post(
    "/deductions",
    { ...base, schema: { tags, summary: "Record a cash deduction (PIN required)", security, body: deductionBody } },
    async (request) => cashService.addStationDeduction(requireStation(request), request.body, meta(request))
  );

  server.get(
    "/history",
    { ...base, schema: { tags, summary: "Per-day ledger and past sends", security, querystring: historyQuery } },
    async (request) => cashService.history(requireStation(request), request.query.limit)
  );

  server.post(
    "/reconciliations",
    {
      ...base,
      schema: { tags, summary: "Send cash to the company over MoMo (PIN required). Charges the sender's MoMo via Paystack.", security, body: initiateReconBody },
    },
    async (request) => cashService.initiate(requireStation(request), request.body, meta(request))
  );

  server.post(
    "/reconciliations/:reference/otp",
    {
      ...base,
      schema: {
        tags,
        summary: "Submit the SMS code Paystack asked for",
        security,
        params: referenceParams,
        body: otpBody,
      },
    },
    async (request) => cashService.submitOtp(requireStation(request), request.params.reference, request.body.otp)
  );

  server.post(
    "/reconciliations/:reference/verify",
    {
      ...base,
      schema: {
        tags,
        summary: "Check with Paystack whether a send went through and complete it",
        security,
        params: referenceParams,
        response: { 200: z.object({ status: z.string() }) },
      },
    },
    async (request) => cashService.verify(requireStation(request), request.params.reference)
  );
}
