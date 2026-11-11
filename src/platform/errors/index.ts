import { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, statusCode = 500, code = "INTERNAL_SERVER_ERROR", details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", code = "NOT_FOUND", details?: unknown) {
    super(message, 404, code, details);
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", code = "BAD_REQUEST", details?: unknown) {
    super(message, 400, code, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", code = "UNAUTHORIZED", details?: unknown) {
    super(message, 401, code, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", code = "FORBIDDEN", details?: unknown) {
    super(message, 403, code, details);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource conflict", code = "CONFLICT", details?: unknown) {
    super(message, 409, code, details);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: unknown) {
    super(message, 422, "UNPROCESSABLE_ENTITY", details);
  }
}

export function globalErrorHandler(
  error: FastifyError | AppError | Error,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const requestId = request.id;

  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      code: error.code,
      message: error.message,
      details: error.details,
      requestId,
    });
  }

  if (error instanceof ZodError) {
    return reply.status(422).send({
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      details: error.format(),
      requestId,
    });
  }

  // Fastify schema validation error
  if ("validation" in error && error.validation) {
    return reply.status(400).send({
      code: "VALIDATION_ERROR",
      message: error.message,
      details: error.validation,
      requestId,
    });
  }

  // Rate limit error
  if ("statusCode" in error && error.statusCode === 429) {
    return reply.status(429).send({
      code: "TOO_MANY_REQUESTS",
      message: "Rate limit exceeded. Please try again later.",
      requestId,
    });
  }

  // Framework-generated 4xx errors (malformed JSON, payload too large, unsupported media type)
  if ("statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
    return reply.status(error.statusCode).send({
      code: (error as FastifyError).code ?? "BAD_REQUEST",
      message: error.message,
      requestId,
    });
  }

  request.log.error({ err: error, requestId }, "Unhandled application exception");

  return reply.status(500).send({
    code: "INTERNAL_SERVER_ERROR",
    message: "An unexpected error occurred. Please contact support.",
    requestId,
  });
}
