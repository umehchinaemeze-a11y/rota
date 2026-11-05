/**
 * Calendar-Month Billing Engine (UTC)
 *
 * Implements:
 * 1. True UTC calendar-month advancement (prohibiting fixed 30-day periods).
 * 2. Anchor-day pinning: preserves the customer's original subscription day-of-month (1-31).
 * 3. Exact month-end clamping (e.g. Jan 31 -> Feb 28/29 -> Mar 31).
 * 4. Leap year arithmetic in UTC.
 * 5. Millisecond-accurate preservation of the original time-of-day anchor in UTC.
 */

/**
 * Validates that an anchor day is an integer between 1 and 31 inclusive.
 */
export function isValidAnchorDay(day: unknown): day is number {
  return typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 31;
}

/**
 * Determines whether a given Gregorian calendar year is a leap year.
 */
export function isLeapYear(year: number): boolean {
  if (!Number.isInteger(year)) {
    throw new TypeError("Year must be an integer.");
  }
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Returns the exact number of days in a specific UTC year and month.
 *
 * @param year - Gregorian year (e.g. 2028)
 * @param monthIndex - 0-indexed month (0 = January, 1 = February, ..., 11 = December)
 */
export function daysInMonthUtc(year: number, monthIndex: number): number {
  if (!Number.isInteger(year)) {
    throw new TypeError("Year must be an integer.");
  }
  if (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    throw new RangeError("monthIndex must be an integer between 0 (January) and 11 (December).");
  }
  // Setting day to 0 of the following month yields the last day of the target month
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Normalizes input date or epoch representation into a valid UTC Date object.
 */
function toValidUtcDate(dateInput: Date | number): Date {
  let date: Date;
  if (typeof dateInput === "number") {
    // If input is in seconds (unix epoch standard in Rota), convert to milliseconds
    const ms = dateInput < 1e11 ? dateInput * 1000 : dateInput;
    date = new Date(ms);
  } else if (dateInput instanceof Date) {
    date = new Date(dateInput.getTime());
  } else {
    throw new TypeError("Date input must be a Date object or numeric timestamp.");
  }

  if (Number.isNaN(date.getTime())) {
    throw new RangeError("Invalid Date provided.");
  }

  return date;
}

/**
 * Resolves the default anchor day (1-31) from a given UTC date.
 */
export function resolveAnchorDay(dateInput: Date | number): number {
  const date = toValidUtcDate(dateInput);
  return date.getUTCDate();
}

/**
 * Advances a date by exactly one UTC calendar month while strictly pinning
 * to the customer's original anchor day and clamping to month ends.
 *
 * Examples:
 * - Jan 31 -> Feb 28 (non-leap) or Feb 29 (leap)
 * - Feb 28 (with anchor 31) -> Mar 31
 * - Mar 31 -> Apr 30
 * - May 31 -> Jun 30
 * - Dec 31, 2026 -> Jan 31, 2027
 *
 * @param fromDate - Starting UTC date or unix timestamp
 * @param anchorDay - Original day-of-month anchor (1-31). Defaults to fromDate's UTC date.
 * @returns New Date object advanced by one calendar month in UTC.
 */
export function advanceCalendarMonth(fromDate: Date | number, anchorDay?: number): Date {
  return advanceCalendarMonths(fromDate, 1, anchorDay);
}

/**
 * Advances a date by a specified number of UTC calendar months while preserving
 * the original anchor day across all month transitions.
 *
 * @param fromDate - Starting UTC date or unix timestamp
 * @param count - Number of months to advance (integer >= 1)
 * @param anchorDay - Original day-of-month anchor (1-31). Defaults to fromDate's UTC date.
 */
export function advanceCalendarMonths(
  fromDate: Date | number,
  count: number = 1,
  anchorDay?: number
): Date {
  const date = toValidUtcDate(fromDate);

  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError("Month advance count must be a non-negative integer.");
  }

  if (count === 0) {
    return date;
  }

  const effectiveAnchor = anchorDay !== undefined ? anchorDay : date.getUTCDate();
  if (!isValidAnchorDay(effectiveAnchor)) {
    throw new RangeError(`Invalid anchorDay: ${effectiveAnchor}. Must be an integer between 1 and 31.`);
  }

  const currentYear = date.getUTCFullYear();
  const currentMonth = date.getUTCMonth(); // 0-11

  // Compute total months from month 0
  const totalMonths = currentMonth + count;
  const targetYear = currentYear + Math.floor(totalMonths / 12);
  const targetMonth = totalMonths % 12;

  // Resolve maximum days in target month (handles leap year if targetMonth === 1)
  const maxDaysInTarget = daysInMonthUtc(targetYear, targetMonth);

  // Clamp the anchor day to the target month's maximum days
  const resolvedDay = Math.min(effectiveAnchor, maxDaysInTarget);

  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    resolvedDay,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds()
  ));
}
