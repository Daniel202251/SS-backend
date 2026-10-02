import { Router } from "express";

import { createSwapController } from "../controllers/swap.controller";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";
import type { AtomicSwapService } from "../services/atomic-swap.service";

export interface SwapRouterDependencies {
  swapService: AtomicSwapService;
  authService?: AuthService;
}

export function createSwapRouter({ swapService, authService }: SwapRouterDependencies): Router {
  const router = Router();
  const controller = createSwapController(swapService);

  if (authService) {
    // History is scoped to the caller's own wallet, so it requires a token.
    router.get("/history", createAuthMiddleware(authService), controller.getHistory);
  }

  // Individual swaps are public: both parties share the record with the
  // counterparty they already transacted with.
  router.get("/:id", controller.getSwap);

  return router;
}
