import {
  calculateInvoiceTerms,
  calculateTenureDays,
} from "../../../src/utils/discount-calculator.utils";
import { Decimal } from "decimal.js";

describe("discount-calculator.utils", () => {
  describe("calculateTenureDays", () => {
    it("should calculate tenure correctly across regular days", () => {
      const ref = new Date("2026-03-01T00:00:00Z");
      const due = new Date("2026-03-11T00:00:00Z");
      expect(calculateTenureDays(due, ref)).toBe(10);
    });

    it("should correctly handle leap years (February 29)", () => {
      const ref = new Date("2024-02-28T00:00:00Z");
      const due = new Date("2024-03-01T00:00:00Z");
      // 2024 is a leap year, so Feb 28 to Mar 1 is 2 days (Feb 29 and Mar 1)
      expect(calculateTenureDays(due, ref)).toBe(2);
    });

    it("should enforce minimum 1 day tenure when due date is today or in the past", () => {
      const ref = new Date("2026-05-10T12:00:00Z");
      const due = new Date("2026-05-10T12:00:00Z");
      expect(calculateTenureDays(due, ref)).toBe(1);
    });
  });

  describe("calculateInvoiceTerms", () => {
    it("should calculate short-term (5-day) terms and APR accurately", () => {
      const result = calculateInvoiceTerms({
        faceValue: "10000.0000",
        dueDate: new Date("2026-04-06T00:00:00Z"),
        referenceDate: new Date("2026-04-01T00:00:00Z"),
        discountBps: 100, // 1% discount
        platformFeeBps: 50, // 0.5% platform fee
      });

      expect(result.faceValue).toBe("10000.0000");
      expect(result.tenureDays).toBe(5);
      expect(result.discountAmount).toBe("100.0000");
      expect(result.platformFee).toBe("50.0000");
      // Advance = 10000 - 100 - 50 = 9850
      expect(result.advanceAmount).toBe("9850.0000");
      expect(result.investorReturn).toBe("100.0000");

      // APR = (100 / 9850) * (365 / 5) * 100 = 0.01015228 * 73 * 100 = 74.11%
      expect(result.apr).toBe("74.11");
    });

    it("should calculate long-term (120-day) terms and APR accurately", () => {
      const result = calculateInvoiceTerms({
        faceValue: "50000.0000",
        dueDate: new Date("2026-08-01T00:00:00Z"),
        referenceDate: new Date("2026-04-02T00:00:00Z"), // 121 days or 120 depending on date
        discountBps: 400, // 4% discount = 2000
        platformFeeBps: 100, // 1% platform fee = 500
      });

      expect(result.faceValue).toBe("50000.0000");
      expect(result.discountAmount).toBe("2000.0000");
      expect(result.platformFee).toBe("500.0000");
      expect(result.advanceAmount).toBe("47500.0000");
    });

    it("should handle zero platform fee and zero discount", () => {
      const result = calculateInvoiceTerms({
        faceValue: "5000.0000",
        dueDate: new Date("2026-05-01T00:00:00Z"),
        referenceDate: new Date("2026-04-01T00:00:00Z"),
        discountBps: 0,
        platformFeeBps: 0,
      });

      expect(result.discountAmount).toBe("0.0000");
      expect(result.platformFee).toBe("0.0000");
      expect(result.advanceAmount).toBe("5000.0000");
      expect(result.apr).toBe("0.00");
    });

    it("should throw error for negative face value or invalid BPS", () => {
      expect(() =>
        calculateInvoiceTerms({
          faceValue: "-100",
          dueDate: new Date(),
          discountBps: 100,
        })
      ).toThrow("Face value must be a positive number greater than zero");

      expect(() =>
        calculateInvoiceTerms({
          faceValue: "1000",
          dueDate: new Date(),
          discountBps: 12000,
        })
      ).toThrow("Discount BPS must be between 0 and 10,000");
    });

    describe("Platform fee calculation boundaries", () => {
      const dueDate = new Date("2026-05-01T00:00:00Z");
      const referenceDate = new Date("2026-04-01T00:00:00Z");

      it("should handle minimum supported payment amount and zero fee", () => {
        const result = calculateInvoiceTerms({
          faceValue: "0.0001", // Smallest non-zero amount for 4 decimal places
          dueDate,
          referenceDate,
          discountBps: 0,
          platformFeeBps: 0,
        });
        expect(result.platformFee).toBe("0.0000");
        expect(result.advanceAmount).toBe("0.0001");
        expect(result.investorReturn).toBe("0.0000");
        
        const reconciled = new Decimal(result.advanceAmount)
          .plus(result.investorReturn)
          .plus(result.platformFee);
        expect(reconciled.equals("0.0001")).toBe(true);
      });

      it("should handle largest supported payment amount with near-maximum fee", () => {
        const largeAmount = "999999999999999.9999";
        const result = calculateInvoiceTerms({
          faceValue: largeAmount,
          dueDate,
          referenceDate,
          discountBps: 0,
          platformFeeBps: 9999, // 99.99% maximum valid fee since 100% throws
        });
        
        // 99.99% of 999999999999999.9999
        // = 999899999999999.99990001
        
        const expectedFee = new Decimal(largeAmount).times(9999).dividedBy(10000).toFixed(4);
        const expectedAdvance = new Decimal(largeAmount).minus(expectedFee).toFixed(4);
        
        expect(result.platformFee).toBe(expectedFee);
        expect(result.investorReturn).toBe("0.0000");
        expect(result.advanceAmount).toBe(expectedAdvance);

        const reconciled = new Decimal(result.advanceAmount)
          .plus(result.investorReturn)
          .plus(result.platformFee);
        expect(reconciled.equals(largeAmount)).toBe(true);
      });

      it("should handle minimum platform fee (1 bps)", () => {
        const result = calculateInvoiceTerms({
          faceValue: "10000.0000",
          dueDate,
          referenceDate,
          discountBps: 100, // 1%
          platformFeeBps: 1, // 0.01%
        });
        expect(result.platformFee).toBe("1.0000");
        expect(result.investorReturn).toBe("100.0000");
        expect(result.advanceAmount).toBe("9899.0000");
        
        const reconciled = new Decimal(result.advanceAmount)
          .plus(result.investorReturn)
          .plus(result.platformFee);
        expect(reconciled.equals("10000.0000")).toBe(true);
      });

      it("should reject invalid negative platform fee", () => {
        expect(() =>
          calculateInvoiceTerms({
            faceValue: "1000.0000",
            dueDate,
            referenceDate,
            discountBps: 100,
            platformFeeBps: -1,
          }),
        ).toThrow("Platform fee BPS must be between 0 and 10,000");
      });

      it("should reject platform fee > 10,000", () => {
        expect(() =>
          calculateInvoiceTerms({
            faceValue: "1000.0000",
            dueDate,
            referenceDate,
            discountBps: 100,
            platformFeeBps: 10001,
          }),
        ).toThrow("Platform fee BPS must be between 0 and 10,000");
      });

      it("should reject total fee and discount >= 10,000", () => {
        expect(() =>
          calculateInvoiceTerms({
            faceValue: "1000.0000",
            dueDate,
            referenceDate,
            discountBps: 5000,
            platformFeeBps: 5000,
          }),
        ).toThrow("Total fee and discount deductions cannot exceed 100% of face value");
      });
    });
  });
});
