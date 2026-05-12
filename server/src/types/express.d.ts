export {};

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      organizationId: string;
      uploadKeyLabel?: string;
    }
  }
}