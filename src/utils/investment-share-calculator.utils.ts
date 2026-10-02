export interface InvestmentShareInput {
  id: string;
  amount: bigint;
}

export interface InvestmentShareResult {
  id: string;
  percentage: number; // exact integer percentage (e.g., 33 for 33%)
}

/**
 * Calculates investment shares using integer arithmetic to ensure the sum
 * is exactly 100% and there is no floating point drift.
 * Remainders are assigned to the investor with the largest amount.
 */
export function calculateInvestmentShares(
  investments: InvestmentShareInput[]
): InvestmentShareResult[] {
  if (investments.length === 0) {
    return [];
  }

  const totalAmount = investments.reduce((sum, inv) => sum + inv.amount, 0n);

  if (totalAmount === 0n) {
    return investments.map((inv) => ({
      id: inv.id,
      percentage: 0,
    }));
  }

  const results = investments.map((inv) => {
    // Integer division to get the floor percentage
    const percentage = Number((inv.amount * 100n) / totalAmount);
    return {
      id: inv.id,
      percentage,
    };
  });

  const currentSum = results.reduce((sum, res) => sum + res.percentage, 0);
  const remainder = 100 - currentSum;

  if (remainder > 0) {
    // Find index of the largest amount.
    // If there is a tie, the first one encountered (stable) will be chosen.
    let maxAmount = -1n;
    let maxIndex = 0;
    
    for (let i = 0; i < investments.length; i++) {
      if (investments[i].amount > maxAmount) {
        maxAmount = investments[i].amount;
        maxIndex = i;
      }
    }

    results[maxIndex].percentage += remainder;
  }

  return results;
}
