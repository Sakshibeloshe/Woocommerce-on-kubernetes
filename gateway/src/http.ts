import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

/** Express 4 doesn't catch errors thrown in async handlers; this wrapper does. */
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Validate a request body; responds 400 with the problems if invalid. */
export function parseBody<T extends z.ZodType>(schema: T, req: Request, res: Response): z.infer<T> | undefined {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      error: "Invalid request",
      details: result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
    });
    return undefined;
  }
  return result.data;
}

/** Postgres "unique_violation" error code. */
export const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";
