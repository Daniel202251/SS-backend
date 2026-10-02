import {
  MIN_LEAD_TIME_MS,
  validateFundingDeadline,
  validateInvoiceForPublish,
} from "../src/lib/validate-invoice-for-publish";
import { Invoice } from "../src/models/Invoice.model";
import { InvoiceStatus } from "../src/types/enums";

/** A fixed instant to measure every boundary against. */
const NOW = new Date("2026-03-01T12:00:00.000Z");

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function offsetFromNow(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

function createInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "invoice-1",
    sellerId: "seller-1",
    invoiceNumber: "INV-001",
    customerName: "Customer A",
    amount: "1000.0000",
    discountRate: "5.00",
    netAmount: "950.0000",
    dueDate: offsetFromNow(48 * HOUR_MS),
    ipfsHash: "QmTestHash",
    riskScore: null,
    status: InvoiceStatus.DRAFT,
    smartContractId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    seller: overrides.seller as Invoice["seller"],
    investments: overrides.investments ?? [],
    transactions: overrides.transactions ?? [],
    ...overrides,
  } as Invoice;
}

describe("validateFundingDeadline", () => {
  it("uses a 24 hour minimum lead time", () => {
    expect(MIN_LEAD_TIME_MS).toBe(24 * HOUR_MS);
  });

  describe("boundary around the 24 hour cutoff", () => {
    it("accepts a deadline exactly 24 hours away", () => {
      expect(validateFundingDeadline(offsetFromNow(MIN_LEAD_TIME_MS), NOW)).toBeNull();
    });

    it("rejects a deadline 23 hours 59 minutes away as too soon", () => {
      const deadline = offsetFromNow(23 * HOUR_MS + 59 * MINUTE_MS);
      expect(validateFundingDeadline(deadline, NOW)).toMatchObject({
        field: "dueDate",
        code: "DUE_DATE_TOO_SOON",
      });
    });

    it("rejects a deadline one millisecond inside the window", () => {
      const deadline = offsetFromNow(MIN_LEAD_TIME_MS - 1);
      expect(validateFundingDeadline(deadline, NOW)).toMatchObject({
        code: "DUE_DATE_TOO_SOON",
      });
    });

    it("accepts a deadline one millisecond outside the window", () => {
      expect(validateFundingDeadline(offsetFromNow(MIN_LEAD_TIME_MS + 1), NOW)).toBeNull();
    });

    it("accepts a deadline 7 days away", () => {
      expect(validateFundingDeadline(offsetFromNow(7 * 24 * HOUR_MS), NOW)).toBeNull();
    });
  });

  describe("deadlines at or before now", () => {
    it("rejects a deadline one hour in the past", () => {
      expect(validateFundingDeadline(offsetFromNow(-HOUR_MS), NOW)).toMatchObject({
        field: "dueDate",
        code: "DUE_DATE_IN_PAST",
      });
    });

    it("rejects a deadline exactly at now", () => {
      expect(validateFundingDeadline(new Date(NOW), NOW)).toMatchObject({
        code: "DUE_DATE_IN_PAST",
      });
    });

    it("rejects a deadline one millisecond in the past", () => {
      expect(validateFundingDeadline(offsetFromNow(-1), NOW)).toMatchObject({
        code: "DUE_DATE_IN_PAST",
      });
    });

    it("distinguishes a past deadline from a merely tight one", () => {
      const past = validateFundingDeadline(offsetFromNow(-HOUR_MS), NOW);
      const tight = validateFundingDeadline(offsetFromNow(HOUR_MS), NOW);
      expect(past?.code).toBe("DUE_DATE_IN_PAST");
      expect(tight?.code).toBe("DUE_DATE_TOO_SOON");
      expect(past?.code).not.toBe(tight?.code);
    });
  });

  it("treats an unparseable deadline as in the past rather than passing it through", () => {
    expect(validateFundingDeadline("not-a-date", NOW)).toMatchObject({
      code: "DUE_DATE_IN_PAST",
    });
  });

  it("accepts an ISO string deadline as well as a Date", () => {
    const iso = offsetFromNow(48 * HOUR_MS).toISOString();
    expect(validateFundingDeadline(iso, NOW)).toBeNull();
  });

  describe("timezone normalization", () => {
    const originalTz = process.env.TZ;

    beforeEach(() => {
      process.env.TZ = "America/New_York";
    });

    afterEach(() => {
      process.env.TZ = originalTz;
    });

    it("evaluates equivalent instants identically regardless of string format", () => {
      const utcString = "2026-03-03T12:00:00.000Z";
      const offsetString = "2026-03-03T14:00:00.000+02:00";
      expect(validateFundingDeadline(utcString, NOW)).toBeNull();
      expect(validateFundingDeadline(offsetString, NOW)).toBeNull();
    });

    it("rejects equivalent past deadlines across timezones", () => {
      const utcString = "2026-03-01T11:00:00.000Z";
      const offsetString = "2026-03-01T06:00:00.000-05:00";
      expect(validateFundingDeadline(utcString, NOW)).toMatchObject({
        code: "DUE_DATE_IN_PAST",
      });
      expect(validateFundingDeadline(offsetString, NOW)).toMatchObject({
        code: "DUE_DATE_IN_PAST",
      });
    });

    it("enforces the exact boundary consistently across timezones", () => {
      const utcBoundary = "2026-03-02T12:00:00.000Z";
      const offsetBoundary = "2026-03-02T17:30:00.000+05:30";
      expect(validateFundingDeadline(utcBoundary, NOW)).toBeNull();
      expect(validateFundingDeadline(offsetBoundary, NOW)).toBeNull();

      const utcTooSoon = "2026-03-02T11:59:59.999Z";
      const offsetTooSoon = "2026-03-02T17:29:59.999+05:30";
      expect(validateFundingDeadline(utcTooSoon, NOW)).toMatchObject({
        code: "DUE_DATE_TOO_SOON",
      });
      expect(validateFundingDeadline(offsetTooSoon, NOW)).toMatchObject({
        code: "DUE_DATE_TOO_SOON",
      });
    });
  });

  describe("clock source", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("reads the server clock when no reference time is supplied", () => {
      jest.useFakeTimers().setSystemTime(NOW);

      // 25 hours past NOW: comfortably valid against the server clock.
      const deadline = offsetFromNow(25 * HOUR_MS);
      expect(validateFundingDeadline(deadline)).toBeNull();

      // Advance the server clock past the deadline; the same deadline is now
      // in the past. Nothing about the input changed, only the clock.
      jest.setSystemTime(offsetFromNow(26 * HOUR_MS));
      expect(validateFundingDeadline(deadline)).toMatchObject({
        code: "DUE_DATE_IN_PAST",
      });
    });

    it("ignores a client-supplied timestamp carried on the request payload", () => {
      jest.useFakeTimers().setSystemTime(NOW);

      // A seller backdating "now" on the payload must not make an expired
      // deadline publishable — the validator never reads request fields.
      const expiredDeadline = offsetFromNow(-HOUR_MS);
      const payload = {
        dueDate: expiredDeadline,
        now: offsetFromNow(-48 * HOUR_MS).toISOString(),
        currentTime: offsetFromNow(-48 * HOUR_MS).toISOString(),
        clientTimestamp: offsetFromNow(-48 * HOUR_MS).getTime(),
      };

      expect(validateFundingDeadline(payload.dueDate)).toMatchObject({
        code: "DUE_DATE_IN_PAST",
      });
    });
  });
});

describe("validateInvoiceForPublish deadline reporting", () => {
  it("reports DUE_DATE_TOO_SOON for a deadline inside the window", () => {
    const invoice = createInvoice({ dueDate: offsetFromNow(HOUR_MS) });
    const errors = validateInvoiceForPublish(invoice, NOW);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ field: "dueDate", code: "DUE_DATE_TOO_SOON" });
  });

  it("reports DUE_DATE_IN_PAST for an expired deadline", () => {
    const invoice = createInvoice({ dueDate: offsetFromNow(-HOUR_MS) });
    const errors = validateInvoiceForPublish(invoice, NOW);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ field: "dueDate", code: "DUE_DATE_IN_PAST" });
  });

  it("reports no deadline error at exactly 24 hours or 7 days out", () => {
    for (const offset of [MIN_LEAD_TIME_MS, 7 * 24 * HOUR_MS]) {
      const invoice = createInvoice({ dueDate: offsetFromNow(offset) });
      expect(validateInvoiceForPublish(invoice, NOW)).toEqual([]);
    }
  });

  it("still reports the deadline alongside other field failures", () => {
    const invoice = createInvoice({
      amount: "1.0000",
      dueDate: offsetFromNow(-HOUR_MS),
      ipfsHash: null,
    });
    const codes = validateInvoiceForPublish(invoice, NOW).map((e) => e.code);
    expect(codes).toEqual(
      expect.arrayContaining(["FACE_VALUE_TOO_LOW", "DUE_DATE_IN_PAST", "MISSING_DOCUMENT"])
    );
  });
});
