import type { AuthenticatedRequestUser } from "./auth";

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedRequestUser;
      requestId?: string;
      correlationId?: string;
      routeBasePath?: string;
    }
  }
}

export {};
