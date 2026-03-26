import { test, expect, describe } from "bun:test";
import { cronMatches } from "../src/conduit/scheduler";

describe("cronMatches", () => {
  // Helper: create a Date for a specific time
  const d = (year: number, month: number, day: number, hour: number, minute: number) =>
    new Date(year, month - 1, day, hour, minute);

  test("wildcard matches everything", () => {
    expect(cronMatches("* * * * *", d(2026, 3, 26, 14, 30))).toBe(true);
  });

  test("exact minute and hour", () => {
    expect(cronMatches("30 9 * * *", d(2026, 3, 26, 9, 30))).toBe(true);
    expect(cronMatches("30 9 * * *", d(2026, 3, 26, 9, 31))).toBe(false);
    expect(cronMatches("30 9 * * *", d(2026, 3, 26, 10, 30))).toBe(false);
  });

  test("step values", () => {
    expect(cronMatches("*/5 * * * *", d(2026, 3, 26, 14, 0))).toBe(true);
    expect(cronMatches("*/5 * * * *", d(2026, 3, 26, 14, 5))).toBe(true);
    expect(cronMatches("*/5 * * * *", d(2026, 3, 26, 14, 10))).toBe(true);
    expect(cronMatches("*/5 * * * *", d(2026, 3, 26, 14, 3))).toBe(false);
  });

  test("range", () => {
    expect(cronMatches("* 9-17 * * *", d(2026, 3, 26, 9, 0))).toBe(true);
    expect(cronMatches("* 9-17 * * *", d(2026, 3, 26, 17, 0))).toBe(true);
    expect(cronMatches("* 9-17 * * *", d(2026, 3, 26, 8, 0))).toBe(false);
    expect(cronMatches("* 9-17 * * *", d(2026, 3, 26, 18, 0))).toBe(false);
  });

  test("range with step", () => {
    expect(cronMatches("1-10/3 * * * *", d(2026, 3, 26, 0, 1))).toBe(true);
    expect(cronMatches("1-10/3 * * * *", d(2026, 3, 26, 0, 4))).toBe(true);
    expect(cronMatches("1-10/3 * * * *", d(2026, 3, 26, 0, 7))).toBe(true);
    expect(cronMatches("1-10/3 * * * *", d(2026, 3, 26, 0, 10))).toBe(true);
    expect(cronMatches("1-10/3 * * * *", d(2026, 3, 26, 0, 2))).toBe(false);
    expect(cronMatches("1-10/3 * * * *", d(2026, 3, 26, 0, 11))).toBe(false);
  });

  test("comma-separated values", () => {
    expect(cronMatches("0,15,30,45 * * * *", d(2026, 3, 26, 14, 0))).toBe(true);
    expect(cronMatches("0,15,30,45 * * * *", d(2026, 3, 26, 14, 15))).toBe(true);
    expect(cronMatches("0,15,30,45 * * * *", d(2026, 3, 26, 14, 7))).toBe(false);
  });

  test("day of week — Monday through Friday", () => {
    // 2026-03-23 is Monday (1), 2026-03-28 is Saturday (6), 2026-03-29 is Sunday (0)
    expect(cronMatches("0 9 * * 1-5", d(2026, 3, 23, 9, 0))).toBe(true);  // Monday
    expect(cronMatches("0 9 * * 1-5", d(2026, 3, 26, 9, 0))).toBe(true);  // Thursday
    expect(cronMatches("0 9 * * 1-5", d(2026, 3, 28, 9, 0))).toBe(false); // Saturday
    expect(cronMatches("0 9 * * 1-5", d(2026, 3, 29, 9, 0))).toBe(false); // Sunday
  });

  test("day of week — Sunday as 0 and 7", () => {
    // 2026-03-29 is Sunday
    expect(cronMatches("0 9 * * 0", d(2026, 3, 29, 9, 0))).toBe(true);
    expect(cronMatches("0 9 * * 7", d(2026, 3, 29, 9, 0))).toBe(true);
  });

  test("specific day of month", () => {
    expect(cronMatches("0 0 1 * *", d(2026, 3, 1, 0, 0))).toBe(true);
    expect(cronMatches("0 0 1 * *", d(2026, 3, 2, 0, 0))).toBe(false);
  });

  test("specific month", () => {
    expect(cronMatches("0 0 * 12 *", d(2026, 12, 25, 0, 0))).toBe(true);
    expect(cronMatches("0 0 * 12 *", d(2026, 3, 25, 0, 0))).toBe(false);
  });

  test("every minute cron", () => {
    expect(cronMatches("*/1 * * * *", d(2026, 3, 26, 14, 0))).toBe(true);
    expect(cronMatches("*/1 * * * *", d(2026, 3, 26, 14, 59))).toBe(true);
  });

  test("invalid expression returns false", () => {
    expect(cronMatches("bad", d(2026, 3, 26, 0, 0))).toBe(false);
    expect(cronMatches("* * *", d(2026, 3, 26, 0, 0))).toBe(false);
  });
});
