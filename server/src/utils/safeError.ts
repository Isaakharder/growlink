import { Response } from "express";

export function sendSafeError(
  res: Response,
  status: number,
  clientMessage: string,
  logContext: string,
  error: unknown
): Response {
  console.error(logContext, error);
  return res.status(status).json({ message: clientMessage });
}
