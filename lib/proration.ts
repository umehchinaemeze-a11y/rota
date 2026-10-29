/**
 * Subscription Proration Calculation Utilities
 *
 * Provides pure, zero-dependency mathematical functions for calculating
 * subscription proration adjustments (seat additions/removals and plan upgrades/downgrades).
 *
 * Design and Policy Guarantees:
 * - Pure calculations: Zero database, network, payment-provider, or environment dependencies.
 * - Explicit cycle lengths: Never hardcodes 30 days; callers must specify totalDaysInCycle.
 * - Configurable precision: Does not assume 2 decimal places; precision is configurable (default: 2).
 * - Explicit sign convention:
 *     - "charge": Positive netAmount (customer owes additional fee for increase).
 *     - "credit": Negative netAmount (customer is owed a credit or refund balance for reduction).
 *     - "none": Zero netAmount (no change or 0 days remaining).
 */

export type RoundingMode = "round" | "floor" | "ceil";

export type ProrationAction = "charge" | "credit" | "none";

export interface SeatProrationParams {
  /** Current seat count allocated to the account (must be an integer >= 0) */
  currentSeats: number;
  /** Desired new seat count (must be an integer >= 0) */
  newSeats: number;
  /** Price per individual seat for the full billing cycle (must be >= 0) */
  seatPricePerCycle: number;
  /** Total number of days in the current billing cycle (must be > 0) */
  totalDaysInCycle: number;
  /** Number of days remaining in the billing cycle (must be >= 0 and <= totalDaysInCycle) */
  daysRemaining: number;
  /** Number of decimal places for currency rounding (default: 2, must be an integer between 0 and 10) */
  precision?: number;
  /** Rounding strategy for fractional currency (default: "round") */
  roundingMode?: RoundingMode;
}

export interface PlanProrationParams {
  /** Price of current plan for the full billing cycle (must be >= 0) */
  currentPlanPrice: number;
  /** Price of new target plan for the full billing cycle (must be >= 0) */
  newPlanPrice: number;
  /** Total number of days in the current billing cycle (must be > 0) */
  totalDaysInCycle: number;
  /** Number of days remaining in the billing cycle (must be >= 0 and <= totalDaysInCycle) */
  daysRemaining: number;
  /** Number of decimal places for currency rounding (default: 2, must be an integer between 0 and 10) */
  precision?: number;
  /** Rounding strategy for fractional currency (default: "round") */
  roundingMode?: RoundingMode;
}

export interface ProrationResult {
  /** Categorized billing direction: "charge", "credit", or "none" */
  action: ProrationAction;
  /** Non-negative prorated amount formatted to specified precision */
  amount: number;
  /** Signed prorated amount (+ for charges, - for credits, 0 for none) */
  netAmount: number;
  /** Difference in units: (newSeats - currentSeats) or (newPlanPrice - currentPlanPrice) */
  unitDifference: number;
  /** Unrounded fraction of the billing cycle remaining (daysRemaining / totalDaysInCycle) */
  fractionRemaining: number;
  /** Validated days remaining in the billing cycle */
  daysRemaining: number;
  /** Validated total days in the billing cycle */
  totalDaysInCycle: number;
}

/**
 * Validates common cycle parameters and calculates remaining fraction.
 */
function validateCycleParams(
  totalDaysInCycle: number,
  daysRemaining: number
): number {
  if (
    typeof totalDaysInCycle !== "number" ||
    !Number.isFinite(totalDaysInCycle) ||
    totalDaysInCycle <= 0
  ) {
    throw new RangeError(
      `totalDaysInCycle must be a positive finite number greater than 0. Received: ${totalDaysInCycle}`
    );
  }

  if (
    typeof daysRemaining !== "number" ||
    !Number.isFinite(daysRemaining) ||
    daysRemaining < 0
  ) {
    throw new RangeError(
      `daysRemaining must be a non-negative finite number (>= 0). Received: ${daysRemaining}`
    );
  }

  if (daysRemaining > totalDaysInCycle) {
    throw new RangeError(
      `daysRemaining (${daysRemaining}) cannot exceed totalDaysInCycle (${totalDaysInCycle}).`
    );
  }

  return daysRemaining / totalDaysInCycle;
}

/**
 * Applies specified rounding mode to a number at given decimal precision.
 */
function applyRounding(
  value: number,
  precision: number = 2,
  mode: RoundingMode = "round"
): number {
  if (
    typeof precision !== "number" ||
    !Number.isInteger(precision) ||
    precision < 0 ||
    precision > 10
  ) {
    throw new RangeError(
      `precision must be an integer between 0 and 10. Received: ${precision}`
    );
  }

  const factor = 10 ** precision;
  let rounded: number;

  switch (mode) {
    case "floor":
      rounded = Math.floor(value * factor) / factor;
      break;
    case "ceil":
      rounded = Math.ceil(value * factor) / factor;
      break;
    case "round":
    default:
      rounded = Math.round(value * factor) / factor;
      break;
  }

  // Normalize negative zero (-0) to standard 0
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Calculates prorated adjustment for adding or removing user seats mid-billing-cycle.
 *
 * @param params SeatProrationParams containing seat counts, unit price, and cycle parameters.
 * @returns ProrationResult containing action type, unsigned amount, and signed netAmount.
 */
export function calculateSeatProration(
  params: SeatProrationParams
): ProrationResult {
  const {
    currentSeats,
    newSeats,
    seatPricePerCycle,
    totalDaysInCycle,
    daysRemaining,
    precision = 2,
    roundingMode = "round",
  } = params;

  if (
    typeof currentSeats !== "number" ||
    !Number.isInteger(currentSeats) ||
    currentSeats < 0
  ) {
    throw new TypeError(
      `currentSeats must be a non-negative integer. Received: ${currentSeats}`
    );
  }

  if (
    typeof newSeats !== "number" ||
    !Number.isInteger(newSeats) ||
    newSeats < 0
  ) {
    throw new TypeError(
      `newSeats must be a non-negative integer. Received: ${newSeats}`
    );
  }

  if (
    typeof seatPricePerCycle !== "number" ||
    !Number.isFinite(seatPricePerCycle) ||
    seatPricePerCycle < 0
  ) {
    throw new RangeError(
      `seatPricePerCycle must be a non-negative finite number. Received: ${seatPricePerCycle}`
    );
  }

  const fractionRemaining = validateCycleParams(totalDaysInCycle, daysRemaining);
  const seatDiff = newSeats - currentSeats;

  if (seatDiff === 0 || daysRemaining === 0 || seatPricePerCycle === 0) {
    return {
      action: "none",
      amount: 0,
      netAmount: 0,
      unitDifference: seatDiff,
      fractionRemaining,
      daysRemaining,
      totalDaysInCycle,
    };
  }

  const rawDelta = seatDiff * seatPricePerCycle * fractionRemaining;
  const roundedAmount = applyRounding(Math.abs(rawDelta), precision, roundingMode);

  if (roundedAmount === 0) {
    return {
      action: "none",
      amount: 0,
      netAmount: 0,
      unitDifference: seatDiff,
      fractionRemaining,
      daysRemaining,
      totalDaysInCycle,
    };
  }

  const isCharge = rawDelta > 0;

  return {
    action: isCharge ? "charge" : "credit",
    amount: roundedAmount,
    netAmount: isCharge ? roundedAmount : -roundedAmount,
    unitDifference: seatDiff,
    fractionRemaining,
    daysRemaining,
    totalDaysInCycle,
  };
}

/**
 * Calculates prorated adjustment for changing subscription tier/plan price mid-billing-cycle.
 *
 * @param params PlanProrationParams containing current and new plan rates and cycle parameters.
 * @returns ProrationResult containing action type, unsigned amount, and signed netAmount.
 */
export function calculatePlanProration(
  params: PlanProrationParams
): ProrationResult {
  const {
    currentPlanPrice,
    newPlanPrice,
    totalDaysInCycle,
    daysRemaining,
    precision = 2,
    roundingMode = "round",
  } = params;

  if (
    typeof currentPlanPrice !== "number" ||
    !Number.isFinite(currentPlanPrice) ||
    currentPlanPrice < 0
  ) {
    throw new RangeError(
      `currentPlanPrice must be a non-negative finite number. Received: ${currentPlanPrice}`
    );
  }

  if (
    typeof newPlanPrice !== "number" ||
    !Number.isFinite(newPlanPrice) ||
    newPlanPrice < 0
  ) {
    throw new RangeError(
      `newPlanPrice must be a non-negative finite number. Received: ${newPlanPrice}`
    );
  }

  const fractionRemaining = validateCycleParams(totalDaysInCycle, daysRemaining);
  const priceDiff = newPlanPrice - currentPlanPrice;

  if (priceDiff === 0 || daysRemaining === 0) {
    return {
      action: "none",
      amount: 0,
      netAmount: 0,
      unitDifference: priceDiff,
      fractionRemaining,
      daysRemaining,
      totalDaysInCycle,
    };
  }

  const rawDelta = priceDiff * fractionRemaining;
  const roundedAmount = applyRounding(Math.abs(rawDelta), precision, roundingMode);

  if (roundedAmount === 0) {
    return {
      action: "none",
      amount: 0,
      netAmount: 0,
      unitDifference: priceDiff,
      fractionRemaining,
      daysRemaining,
      totalDaysInCycle,
    };
  }

  const isCharge = rawDelta > 0;

  return {
    action: isCharge ? "charge" : "credit",
    amount: roundedAmount,
    netAmount: isCharge ? roundedAmount : -roundedAmount,
    unitDifference: priceDiff,
    fractionRemaining,
    daysRemaining,
    totalDaysInCycle,
  };
}

/**
 * Helper to calculate total calendar days and remaining days between two dates.
 * Correctly accounts for variable month lengths (e.g. 28/29 day February, 30/31 days).
 */
export function calculateCycleDaysFromDates(
  cycleStartDate: Date | string,
  cycleEndDate: Date | string,
  effectiveChangeDate: Date | string
): { totalDaysInCycle: number; daysRemaining: number } {
  const start = new Date(cycleStartDate);
  const end = new Date(cycleEndDate);
  const effective = new Date(effectiveChangeDate);

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    Number.isNaN(effective.getTime())
  ) {
    throw new TypeError("All dates must be valid Date instances or ISO date strings.");
  }

  const startMs = start.getTime();
  const endMs = end.getTime();
  const effectiveMs = effective.getTime();

  if (endMs <= startMs) {
    throw new RangeError("cycleEndDate must be strictly after cycleStartDate.");
  }

  if (effectiveMs < startMs || effectiveMs > endMs) {
    throw new RangeError("effectiveChangeDate must be between cycleStartDate and cycleEndDate.");
  }

  const msPerDay = 1000 * 60 * 60 * 24;
  const totalDaysInCycle = (endMs - startMs) / msPerDay;
  const daysRemaining = (endMs - effectiveMs) / msPerDay;

  return { totalDaysInCycle, daysRemaining };
}
