import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

// Direct import of pure proration utility via Node native type stripping
import {
  calculateSeatProration,
  calculatePlanProration,
  calculateCycleDaysFromDates,
} from "../lib/proration.ts";

describe("Subscription Proration — Seat Count Adjustments", () => {
  it("calculates positive charge for mid-cycle seat addition (10 to 15 seats, 15 of 30 days)", () => {
    // 5 additional seats @ $20/month with 15/30 days remaining = 5 * 20 * 0.5 = $50.00
    const result = calculateSeatProration({
      currentSeats: 10,
      newSeats: 15,
      seatPricePerCycle: 20,
      totalDaysInCycle: 30,
      daysRemaining: 15,
    });

    assert.equal(result.action, "charge");
    assert.equal(result.amount, 50);
    assert.equal(result.netAmount, 50);
    assert.equal(result.unitDifference, 5);
    assert.equal(result.fractionRemaining, 0.5);
    assert.equal(result.daysRemaining, 15);
    assert.equal(result.totalDaysInCycle, 30);
  });

  it("calculates negative credit for mid-cycle seat reduction (15 to 10 seats, 15 of 30 days)", () => {
    // 5 reduced seats @ $20/month with 15/30 days remaining = -5 * 20 * 0.5 = -$50.00
    const result = calculateSeatProration({
      currentSeats: 15,
      newSeats: 10,
      seatPricePerCycle: 20,
      totalDaysInCycle: 30,
      daysRemaining: 15,
    });

    assert.equal(result.action, "credit");
    assert.equal(result.amount, 50);
    assert.equal(result.netAmount, -50);
    assert.equal(result.unitDifference, -5);
    assert.equal(result.fractionRemaining, 0.5);
  });

  it("returns zero amount and action 'none' when seat count is unchanged", () => {
    const result = calculateSeatProration({
      currentSeats: 10,
      newSeats: 10,
      seatPricePerCycle: 25,
      totalDaysInCycle: 30,
      daysRemaining: 10,
    });

    assert.equal(result.action, "none");
    assert.equal(result.amount, 0);
    assert.equal(result.netAmount, 0);
    assert.equal(result.unitDifference, 0);
  });

  it("returns zero amount and action 'none' when 0 days remain in cycle", () => {
    const result = calculateSeatProration({
      currentSeats: 5,
      newSeats: 20,
      seatPricePerCycle: 30,
      totalDaysInCycle: 30,
      daysRemaining: 0,
    });

    assert.equal(result.action, "none");
    assert.equal(result.amount, 0);
    assert.equal(result.netAmount, 0);
    assert.equal(result.fractionRemaining, 0);
  });

  it("calculates full cycle charge when entire billing cycle remains (daysRemaining == totalDaysInCycle)", () => {
    // 2 seats added @ $40 with 31 of 31 days = 2 * 40 * 1 = $80.00
    const result = calculateSeatProration({
      currentSeats: 3,
      newSeats: 5,
      seatPricePerCycle: 40,
      totalDaysInCycle: 31,
      daysRemaining: 31,
    });

    assert.equal(result.action, "charge");
    assert.equal(result.amount, 80);
    assert.equal(result.netAmount, 80);
    assert.equal(result.fractionRemaining, 1);
  });

  it("handles non-standard cycle lengths: 29-day leap year February", () => {
    // 1 seat added @ $29/seat in a 29-day cycle with 10 days remaining
    // raw = 1 * 29 * (10 / 29) = 10.00
    const result = calculateSeatProration({
      currentSeats: 2,
      newSeats: 3,
      seatPricePerCycle: 29,
      totalDaysInCycle: 29,
      daysRemaining: 10,
    });

    assert.equal(result.action, "charge");
    assert.equal(result.amount, 10);
    assert.equal(result.netAmount, 10);
    assert.equal(result.fractionRemaining, 10 / 29);
  });

  it("handles non-standard cycle lengths: 365-day annual subscription", () => {
    // 10 seats added @ $120/seat/yr with 73 days remaining (73/365 = 0.2)
    // raw = 10 * 120 * 0.2 = $240.00
    const result = calculateSeatProration({
      currentSeats: 10,
      newSeats: 20,
      seatPricePerCycle: 120,
      totalDaysInCycle: 365,
      daysRemaining: 73,
    });

    assert.equal(result.action, "charge");
    assert.equal(result.amount, 240);
    assert.equal(result.netAmount, 240);
  });
});

describe("Subscription Proration — Plan Tier Upgrades and Downgrades", () => {
  it("calculates positive charge for mid-cycle plan upgrade ($50 to $120, 15 of 30 days)", () => {
    // Upgrade from $50/mo to $120/mo with 15/30 days remaining = ($120 - $50) * 0.5 = $35.00
    const result = calculatePlanProration({
      currentPlanPrice: 50,
      newPlanPrice: 120,
      totalDaysInCycle: 30,
      daysRemaining: 15,
    });

    assert.equal(result.action, "charge");
    assert.equal(result.amount, 35);
    assert.equal(result.netAmount, 35);
    assert.equal(result.unitDifference, 70);
  });

  it("calculates negative credit for mid-cycle plan downgrade ($120 to $50, 15 of 30 days)", () => {
    // Downgrade from $120/mo to $50/mo with 15/30 days remaining = ($50 - $120) * 0.5 = -$35.00
    const result = calculatePlanProration({
      currentPlanPrice: 120,
      newPlanPrice: 50,
      totalDaysInCycle: 30,
      daysRemaining: 15,
    });

    assert.equal(result.action, "credit");
    assert.equal(result.amount, 35);
    assert.equal(result.netAmount, -35);
    assert.equal(result.unitDifference, -70);
  });

  it("returns zero amount and action 'none' when current and new plan prices are identical", () => {
    const result = calculatePlanProration({
      currentPlanPrice: 99,
      newPlanPrice: 99,
      totalDaysInCycle: 30,
      daysRemaining: 20,
    });

    assert.equal(result.action, "none");
    assert.equal(result.amount, 0);
    assert.equal(result.netAmount, 0);
    assert.equal(result.unitDifference, 0);
  });

  it("handles fractional days (e.g. 10.5 days remaining in 28-day February cycle)", () => {
    // Upgrade from $0 (Free) to $100 with 10.5 of 28 days = 100 * (10.5 / 28) = 100 * 0.375 = $37.50
    const result = calculatePlanProration({
      currentPlanPrice: 0,
      newPlanPrice: 100,
      totalDaysInCycle: 28,
      daysRemaining: 10.5,
    });

    assert.equal(result.action, "charge");
    assert.equal(result.amount, 37.5);
    assert.equal(result.netAmount, 37.5);
    assert.equal(result.fractionRemaining, 0.375);
  });
});

describe("Subscription Proration — Precision and Currency Rounding", () => {
  it("rounds to 2 decimal places by default (standard half-up)", () => {
    // $10 difference over 30 days with 7 days remaining: 10 * 7 / 30 = 2.333333... -> 2.33
    const result = calculatePlanProration({
      currentPlanPrice: 0,
      newPlanPrice: 10,
      totalDaysInCycle: 30,
      daysRemaining: 7,
    });

    assert.equal(result.amount, 2.33);
    assert.equal(result.netAmount, 2.33);
  });

  it("supports precision 0 for whole currency units (e.g. JPY or integer cents)", () => {
    // 10 * 7 / 30 = 2.3333 -> rounds to 2
    const result = calculatePlanProration({
      currentPlanPrice: 0,
      newPlanPrice: 10,
      totalDaysInCycle: 30,
      daysRemaining: 7,
      precision: 0,
    });

    assert.equal(result.amount, 2);
    assert.equal(result.netAmount, 2);
  });

  it("supports precision 4 for fractional micro-billing", () => {
    // 10 * 7 / 30 = 2.333333... -> 2.3333
    const result = calculatePlanProration({
      currentPlanPrice: 0,
      newPlanPrice: 10,
      totalDaysInCycle: 30,
      daysRemaining: 7,
      precision: 4,
    });

    assert.equal(result.amount, 2.3333);
    assert.equal(result.netAmount, 2.3333);
  });

  it("supports custom rounding modes: floor and ceil", () => {
    // 10 * 7 / 30 = 2.33333...
    const floored = calculatePlanProration({
      currentPlanPrice: 0,
      newPlanPrice: 10,
      totalDaysInCycle: 30,
      daysRemaining: 7,
      roundingMode: "floor",
    });
    assert.equal(floored.amount, 2.33);

    const ceiled = calculatePlanProration({
      currentPlanPrice: 0,
      newPlanPrice: 10,
      totalDaysInCycle: 30,
      daysRemaining: 7,
      roundingMode: "ceil",
    });
    assert.equal(ceiled.amount, 2.34);
  });
});

describe("Subscription Proration — Calendar Date Cycle Helper", () => {
  it("calculates exact cycle days across a non-leap February (2025)", () => {
    // 2025-02-01 to 2025-03-01 is exactly 28 days
    const { totalDaysInCycle, daysRemaining } = calculateCycleDaysFromDates(
      "2025-02-01T00:00:00.000Z",
      "2025-03-01T00:00:00.000Z",
      "2025-02-15T00:00:00.000Z"
    );

    assert.equal(totalDaysInCycle, 28);
    assert.equal(daysRemaining, 14);
  });

  it("calculates exact cycle days across a leap-year February (2024)", () => {
    // 2024-02-01 to 2024-03-01 is exactly 29 days
    const { totalDaysInCycle, daysRemaining } = calculateCycleDaysFromDates(
      "2024-02-01T00:00:00.000Z",
      "2024-03-01T00:00:00.000Z",
      "2024-02-15T00:00:00.000Z"
    );

    assert.equal(totalDaysInCycle, 29);
    assert.equal(daysRemaining, 15);
  });

  it("rejects invalid date parameters", () => {
    assert.throws(
      () => calculateCycleDaysFromDates("invalid", "2025-03-01", "2025-02-15"),
      TypeError
    );
    assert.throws(
      () =>
        calculateCycleDaysFromDates(
          "2025-03-01T00:00:00Z",
          "2025-02-01T00:00:00Z",
          "2025-02-15T00:00:00Z"
        ),
      RangeError
    );
  });
});

describe("Subscription Proration — Input Validation and Error Guards", () => {
  it("rejects zero or negative cycle lengths", () => {
    assert.throws(
      () =>
        calculateSeatProration({
          currentSeats: 1,
          newSeats: 2,
          seatPricePerCycle: 10,
          totalDaysInCycle: 0,
          daysRemaining: 0,
        }),
      RangeError
    );

    assert.throws(
      () =>
        calculatePlanProration({
          currentPlanPrice: 10,
          newPlanPrice: 20,
          totalDaysInCycle: -30,
          daysRemaining: 15,
        }),
      RangeError
    );
  });

  it("rejects negative daysRemaining", () => {
    assert.throws(
      () =>
        calculateSeatProration({
          currentSeats: 1,
          newSeats: 2,
          seatPricePerCycle: 10,
          totalDaysInCycle: 30,
          daysRemaining: -5,
        }),
      RangeError
    );
  });

  it("rejects daysRemaining greater than totalDaysInCycle", () => {
    assert.throws(
      () =>
        calculateSeatProration({
          currentSeats: 1,
          newSeats: 2,
          seatPricePerCycle: 10,
          totalDaysInCycle: 30,
          daysRemaining: 35,
        }),
      RangeError
    );
  });

  it("rejects non-integer or negative seat counts", () => {
    assert.throws(
      () =>
        calculateSeatProration({
          currentSeats: -1,
          newSeats: 5,
          seatPricePerCycle: 10,
          totalDaysInCycle: 30,
          daysRemaining: 15,
        }),
      TypeError
    );

    assert.throws(
      () =>
        calculateSeatProration({
          currentSeats: 2.5,
          newSeats: 5,
          seatPricePerCycle: 10,
          totalDaysInCycle: 30,
          daysRemaining: 15,
        }),
      TypeError
    );
  });

  it("rejects negative prices", () => {
    assert.throws(
      () =>
        calculateSeatProration({
          currentSeats: 1,
          newSeats: 2,
          seatPricePerCycle: -10,
          totalDaysInCycle: 30,
          daysRemaining: 15,
        }),
      RangeError
    );

    assert.throws(
      () =>
        calculatePlanProration({
          currentPlanPrice: -50,
          newPlanPrice: 100,
          totalDaysInCycle: 30,
          daysRemaining: 15,
        }),
      RangeError
    );
  });

  it("rejects invalid precision values", () => {
    assert.throws(
      () =>
        calculatePlanProration({
          currentPlanPrice: 10,
          newPlanPrice: 20,
          totalDaysInCycle: 30,
          daysRemaining: 15,
          precision: -1,
        }),
      RangeError
    );

    assert.throws(
      () =>
        calculatePlanProration({
          currentPlanPrice: 10,
          newPlanPrice: 20,
          totalDaysInCycle: 30,
          daysRemaining: 15,
          precision: 15,
        }),
      RangeError
    );
  });
});
