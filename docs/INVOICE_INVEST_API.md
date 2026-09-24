# Fractional invoice investment

`POST /api/v1/invoices/:id/invest` buys a fractional share of a published
invoice.

## Request

Requires a bearer token for a user with approved KYC. It is rate limited to 10
requests per wallet per minute and blocked while the escrow contract is paused.

```json
{
  "walletAddress": "GABC...XYZ",
  "amount": "250.50",
  "ledgerSequence": 51234567
}
```

| Field            | Rules                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `walletAddress`  | Valid Stellar public key and must match the authenticated user's wallet                                                      |
| `amount`         | Positive, at most 4 decimal places                                                                                           |
| `ledgerSequence` | Optional ledger the payment targets. Without it the server uses the current 5-second funding window (about one ledger close) |

## Response `201`

```json
{
  "success": true,
  "data": {
    "investment": {
      "id": "…",
      "invoiceId": "…",
      "investorWallet": "GABC...XYZ",
      "investmentAmount": "250.5000",
      "expectedReturn": "263.6842",
      "status": "pending",
      "fundingBlock": "51234567",
      "createdAt": "…"
    },
    "funding": {
      "invoiceId": "…",
      "status": "published",
      "targetAmount": "950.0000",
      "fundedAmount": "700.5000",
      "remainingCapacity": "249.5000",
      "fundedPercent": "73.74",
      "version": 7
    }
  }
}
```

When the investment fills the invoice, `funding.status` is `funded` and the
invoice moves to `funded` through the status state machine.

## Errors

| Status | Code                                                  | When                                                                   |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| 400    | `HTTP_400` / `INVALID_AMOUNT`                         | Body fails validation                                                  |
| 401    | `HTTP_401`                                            | Missing or invalid token                                               |
| 403    | `KYC_NOT_APPROVED`, `WALLET_MISMATCH`, `SELF_DEALING` | Not allowed to invest                                                  |
| 404    | `INVOICE_NOT_FOUND`                                   | Unknown invoice                                                        |
| 409    | `DUPLICATE_INVESTMENT`                                | Same wallet already invested in this invoice in the same block         |
| 409    | `CONCURRENT_INVESTMENT_CONFLICT`                      | Lost the race 3 times in a row; safe to retry                          |
| 422    | `INSUFFICIENT_CAPACITY`                               | Amount exceeds what is left; `details.remainingCapacity` says how much |
| 422    | `INVOICE_NOT_OPEN_FOR_INVESTMENT`, `INVOICE_EXPIRED`  | Invoice is not published, or is past due                               |

## How over-funding is prevented

1. The remaining capacity (`net_amount - funded_amount`) is checked against the
   invoice as read.
2. `funded_amount` is increased by one conditional `UPDATE`. It matches only if
   the invoice `version` has not changed since that read (optimistic lock), the
   invoice is still `published`, and the new total fits within `net_amount`. If
   it matches no rows, another investment got there first. The request then
   retries from a fresh read, up to 3 attempts.
3. A `CHECK (funded_amount <= net_amount)` constraint on `invoices` rejects any
   write that would over-fund, whatever code path it comes from.

The `UPDATE`, the investment insert and the move to `funded` all run in one
transaction. A unique index on `investments (invoice_id, investor_wallet,
funding_block)` rejects a duplicate that races past the pre-check, and the
failed transaction rolls back its `funded_amount` change. Notifications go out
only after commit.

`POST /api/v1/investments` keeps `funded_amount` in sync too, so both paths
agree on capacity.
