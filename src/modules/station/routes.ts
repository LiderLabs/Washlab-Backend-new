import { FastifyInstance, FastifyRequest } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { authenticateStation, requireStation, STATION_TOKEN_HEADER } from "../../platform/auth/station.js";
import { stationService } from "./service.js";
import {
  activeAttendanceSchema,
  attendanceResultSchema,
  clockInSchema,
  clockOutSchema,
  stationAttendantSchema,
  stationLoginResponseSchema,
  stationLoginSchema,
  stationSessionResponseSchema,
} from "./schemas.js";

const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers["user-agent"] });

// Every attendant at a branch shares one IP, so limit station traffic per session token instead of per IP.
const perStationLimit = {
  rateLimit: {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => String(req.headers[STATION_TOKEN_HEADER] ?? req.ip),
  },
};
const security = [{ stationToken: [] }];

export async function stationRoutes(app: FastifyInstance) {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    "/login",
    {
      // PIN guessing: tight per-IP limit here, plus a DB lockout per branch in the service.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["Station"],
        summary: "Log a device in to a branch with the station PIN",
        body: stationLoginSchema,
        response: { 200: stationLoginResponseSchema },
      },
    },
    async (request) => stationService.login(request.body, meta(request))
  );

  server.post(
    "/logout",
    {
      onRequest: [authenticateStation],
      config: perStationLimit,
      schema: {
        tags: ["Station"],
        summary: "End this station session",
        security,
        response: { 200: z.object({ success: z.boolean() }) },
      },
    },
    async (request) => stationService.logout(requireStation(request), meta(request))
  );

  server.get(
    "/session",
    {
      onRequest: [authenticateStation],
      config: perStationLimit,
      schema: {
        tags: ["Station"],
        summary: "Current station session and branch",
        security,
        response: { 200: stationSessionResponseSchema },
      },
    },
    async (request) => stationService.getSession(requireStation(request))
  );

  server.get(
    "/attendants",
    {
      onRequest: [authenticateStation],
      config: perStationLimit,
      schema: {
        tags: ["Station"],
        summary: "Attendants who can clock in at this branch",
        security,
        response: { 200: z.array(stationAttendantSchema) },
      },
    },
    async (request) => stationService.listAttendants(requireStation(request).branchId)
  );

  server.get(
    "/attendance/active",
    {
      onRequest: [authenticateStation],
      config: perStationLimit,
      schema: {
        tags: ["Station"],
        summary: "Attendants currently clocked in at this branch",
        security,
        response: { 200: z.array(activeAttendanceSchema) },
      },
    },
    async (request) => stationService.activeAttendances(requireStation(request).branchId)
  );

  server.post(
    "/attendance/clock-in",
    {
      onRequest: [authenticateStation],
      config: perStationLimit,
      schema: {
        tags: ["Station"],
        summary: "Clock an attendant in with their PIN",
        security,
        body: clockInSchema,
        response: { 200: attendanceResultSchema },
      },
    },
    async (request) => stationService.clockIn(requireStation(request), request.body, meta(request))
  );

  server.post(
    "/attendance/clock-out",
    {
      onRequest: [authenticateStation],
      config: perStationLimit,
      schema: {
        tags: ["Station"],
        summary: "Clock an attendant out with their PIN",
        security,
        body: clockOutSchema,
        response: { 200: attendanceResultSchema },
      },
    },
    async (request) => stationService.clockOut(requireStation(request), request.body, meta(request))
  );
}
