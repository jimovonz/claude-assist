import { test, expect, describe } from "bun:test";
import { cronMatches, resolveNotify } from "../src/conduit/scheduler";

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

describe("resolveNotify", () => {
  describe("always mode", () => {
    test("notifies when there is output", () => {
      const result = resolveNotify("always", "Some output");
      expect(result.shouldNotify).toBe(true);
      expect(result.output).toBe("Some output");
    });

    test("does not notify on empty output", () => {
      const result = resolveNotify("always", "");
      expect(result.shouldNotify).toBe(false);
    });

    test("strips notify tag but still notifies", () => {
      const result = resolveNotify("always", "<notify>false</notify>\nAll good");
      expect(result.shouldNotify).toBe(true);
      expect(result.output).toBe("All good");
    });
  });

  describe("never mode", () => {
    test("never notifies regardless of content", () => {
      const result = resolveNotify("never", "Important alert!");
      expect(result.shouldNotify).toBe(false);
      expect(result.output).toBe("Important alert!");
    });

    test("never notifies even with notify true tag", () => {
      const result = resolveNotify("never", "<notify>true</notify>\nAlert!");
      expect(result.shouldNotify).toBe(false);
    });
  });

  describe("auto mode", () => {
    test("notifies when tag is true", () => {
      const result = resolveNotify("auto", "<notify>true</notify>\nDisk at 95%!");
      expect(result.shouldNotify).toBe(true);
      expect(result.output).toBe("Disk at 95%!");
    });

    test("suppresses when tag is false", () => {
      const result = resolveNotify("auto", "<notify>false</notify>\nAll systems healthy.");
      expect(result.shouldNotify).toBe(false);
      expect(result.output).toBe("All systems healthy.");
    });

    test("defaults to NOT notify when no tag present", () => {
      const result = resolveNotify("auto", "Output without tag");
      expect(result.shouldNotify).toBe(false);
      expect(result.output).toBe("Output without tag");
    });

    test("handles tag with whitespace", () => {
      const result = resolveNotify("auto", "<notify> true </notify>\nAlert");
      expect(result.shouldNotify).toBe(true);
      expect(result.output).toBe("Alert");
    });

    test("handles case-insensitive tag", () => {
      const result = resolveNotify("auto", "<notify>True</notify>\nAlert");
      expect(result.shouldNotify).toBe(true);
    });

    test("handles tag with surrounding content", () => {
      const result = resolveNotify("auto", "<notify>false</notify>\n\n## Summary\nAll good.");
      expect(result.shouldNotify).toBe(false);
      expect(result.output).toBe("## Summary\nAll good.");
    });
  });
});
