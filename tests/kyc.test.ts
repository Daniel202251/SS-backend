import { requireApprovedKYC, truncateWalletAddress } from "@/lib/kyc";
import { KYCStatus } from "@/types/enums";

describe("KYC check", () => {
  it("blocks non-approved users", () => {
    expect(() => requireApprovedKYC({ kycStatus: KYCStatus.PENDING })).toThrow();
  });

  it("allows approved users", () => {
    expect(() => requireApprovedKYC({ kycStatus: KYCStatus.APPROVED })).not.toThrow();
  });
});

describe("truncateWalletAddress", () => {
  it("keeps the first 4 and last 4 characters", () => {
    expect(truncateWalletAddress("GABCDEFGHIJKLMNOPQRSTUVWXYZ")).toBe("GABC...WXYZ");
  });

  it("returns short addresses unchanged", () => {
    expect(truncateWalletAddress("GABC")).toBe("GABC");
  });
});
