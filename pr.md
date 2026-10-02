## Description

This PR hardens backend services, routes, escrow contract guards, and updates repository configuration.

### Addressed Issues
- closes #303
- closes #302
- closes #301
- closes #300

### Key Changes
- **Auth Routes (`src/routes/auth.routes.ts`)**: Optimized and hardened request validation schemas and error handling wrapper for auth routes.
- **Invoice Service (`src/services/invoice.service.ts`)**: Added `rejectInvoice` functionality with status transition validation, rejection reason persistence, and seller notification.
- **Contract Guard Service (`src/services/stellar/contract-guard.service.ts`)**: Fixed Soroban contract address parsing and ledger key building to prevent cache poisoning on RPC errors.
- **Git Ignore (`.gitignore`)**: Added `mimo` build and configuration artifacts ignore patterns.
