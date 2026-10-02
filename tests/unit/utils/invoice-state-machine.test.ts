import { InvoiceStatus } from "../../../src/types/enums";
import { isValidInvoiceStateTransition } from "../../../src/utils/invoice-state.utils";

describe("isValidInvoiceStateTransition", () => {
  const allStatuses = Object.values(InvoiceStatus);

  describe("valid transitions from DRAFT", () => {
    it("allows transition from DRAFT to PUBLISHED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.DRAFT, InvoiceStatus.PUBLISHED)).toBe(
        true
      );
    });

    it("allows transition from DRAFT to CANCELLED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.DRAFT, InvoiceStatus.CANCELLED)).toBe(
        true
      );
    });

    it("rejects transition from DRAFT to FUNDED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.DRAFT, InvoiceStatus.FUNDED)).toBe(false);
    });

    it("rejects transition from DRAFT to SETTLED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.DRAFT, InvoiceStatus.SETTLED)).toBe(false);
    });

    it("rejects transition from DRAFT to PENDING", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.DRAFT, InvoiceStatus.PENDING)).toBe(false);
    });

    it("rejects transition from DRAFT to DRAFT", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.DRAFT, InvoiceStatus.DRAFT)).toBe(false);
    });
  });

  describe("valid transitions from PENDING", () => {
    it("allows transition from PENDING to PUBLISHED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.PENDING, InvoiceStatus.PUBLISHED)).toBe(
        true
      );
    });

    it("allows transition from PENDING to CANCELLED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.PENDING, InvoiceStatus.CANCELLED)).toBe(
        true
      );
    });

    it("rejects transition from PENDING to DRAFT", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.PENDING, InvoiceStatus.DRAFT)).toBe(false);
    });

    it("rejects transition from PENDING to FUNDED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.PENDING, InvoiceStatus.FUNDED)).toBe(
        false
      );
    });
  });

  describe("valid transitions from PUBLISHED", () => {
    it("allows transition from PUBLISHED to FUNDED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.PUBLISHED, InvoiceStatus.FUNDED)).toBe(
        true
      );
    });

    it("allows transition from PUBLISHED to CANCELLED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.PUBLISHED, InvoiceStatus.CANCELLED)).toBe(
        true
      );
    });

    it("rejects transition from PUBLISHED to DRAFT", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.PUBLISHED, InvoiceStatus.DRAFT)).toBe(
        false
      );
    });

    it("rejects transition from PUBLISHED to SETTLED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.PUBLISHED, InvoiceStatus.SETTLED)).toBe(
        false
      );
    });

    it("rejects transition from PUBLISHED to PENDING", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.PUBLISHED, InvoiceStatus.PENDING)).toBe(
        false
      );
    });
  });

  describe("valid transitions from FUNDED", () => {
    it("allows transition from FUNDED to SETTLED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.FUNDED, InvoiceStatus.SETTLED)).toBe(true);
    });

    it("allows transition from FUNDED to CANCELLED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.FUNDED, InvoiceStatus.CANCELLED)).toBe(
        true
      );
    });

    it("rejects transition from FUNDED to DRAFT", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.FUNDED, InvoiceStatus.DRAFT)).toBe(false);
    });

    it("rejects transition from FUNDED to PUBLISHED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.FUNDED, InvoiceStatus.PUBLISHED)).toBe(
        false
      );
    });

    it("rejects transition from FUNDED to PENDING", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.FUNDED, InvoiceStatus.PENDING)).toBe(
        false
      );
    });
  });

  describe("valid transitions from SETTLED", () => {
    it("allows transition from SETTLED to CANCELLED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.SETTLED, InvoiceStatus.CANCELLED)).toBe(
        true
      );
    });

    it("rejects transition from SETTLED to DRAFT", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.SETTLED, InvoiceStatus.DRAFT)).toBe(false);
    });

    it("rejects transition from SETTLED to PENDING", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.SETTLED, InvoiceStatus.PENDING)).toBe(
        false
      );
    });

    it("rejects transition from SETTLED to PUBLISHED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.SETTLED, InvoiceStatus.PUBLISHED)).toBe(
        false
      );
    });

    it("rejects transition from SETTLED to FUNDED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.SETTLED, InvoiceStatus.FUNDED)).toBe(
        false
      );
    });

    it("rejects transition from SETTLED to SETTLED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.SETTLED, InvoiceStatus.SETTLED)).toBe(
        false
      );
    });
  });

  describe("valid transitions from CANCELLED", () => {
    it("rejects all transitions from CANCELLED", () => {
      allStatuses.forEach((status) => {
        expect(isValidInvoiceStateTransition(InvoiceStatus.CANCELLED, status)).toBe(false);
      });
    });
  });

  describe("invalid self-transitions", () => {
    it("rejects transition from PENDING to PENDING", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.PENDING, InvoiceStatus.PENDING)).toBe(
        false
      );
    });

    it("rejects transition from PUBLISHED to PUBLISHED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.PUBLISHED, InvoiceStatus.PUBLISHED)).toBe(
        false
      );
    });

    it("rejects transition from FUNDED to FUNDED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.FUNDED, InvoiceStatus.FUNDED)).toBe(false);
    });

    it("rejects transition from CANCELLED to CANCELLED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.CANCELLED, InvoiceStatus.CANCELLED)).toBe(
        false
      );
    });
  });

  describe("backward transitions (all invalid)", () => {
    it("rejects transition from PUBLISHED to DRAFT", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.PUBLISHED, InvoiceStatus.DRAFT)).toBe(
        false
      );
    });

    it("rejects transition from FUNDED to PUBLISHED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.FUNDED, InvoiceStatus.PUBLISHED)).toBe(
        false
      );
    });

    it("rejects transition from SETTLED to FUNDED", () => {
      expect(isValidInvoiceStateTransition(InvoiceStatus.SETTLED, InvoiceStatus.FUNDED)).toBe(
        false
      );
    });
  });
});
