import { test, expect, describe } from "bun:test";
import { extractActions } from "../src/views/renderer";
import { stripMetadata } from "../src/conduit/router";

describe("extractActions", () => {
  test("extracts single action", () => {
    const input = 'Some text\n<action id="ack">Acknowledge</action>\nMore text';
    const { content, actions } = extractActions(input);
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe("ack");
    expect(actions[0].label).toBe("Acknowledge");
    expect(content).not.toContain("<action");
    expect(content).toContain("Some text");
    expect(content).toContain("More text");
  });

  test("extracts multiple actions", () => {
    const input = 'Report\n<action id="ack">Acknowledge</action>\n<action id="snooze">Snooze 1h</action>\n<action id="fix">Run cleanup</action>';
    const { content, actions } = extractActions(input);
    expect(actions).toHaveLength(3);
    expect(actions[0]).toEqual({ id: "ack", label: "Acknowledge" });
    expect(actions[1]).toEqual({ id: "snooze", label: "Snooze 1h" });
    expect(actions[2]).toEqual({ id: "fix", label: "Run cleanup" });
    expect(content).not.toContain("<action");
  });

  test("returns empty actions for content without tags", () => {
    const input = "Just regular text with no actions";
    const { content, actions } = extractActions(input);
    expect(actions).toHaveLength(0);
    expect(content).toBe(input);
  });

  test("handles actions with extra attributes", () => {
    const input = '<action id="test" class="primary">Do it</action>';
    const { actions } = extractActions(input);
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe("test");
    expect(actions[0].label).toBe("Do it");
  });

  test("is case-insensitive", () => {
    const input = '<ACTION id="test">Test</ACTION>';
    const { actions } = extractActions(input);
    expect(actions).toHaveLength(1);
  });

  test("trims whitespace from id and label", () => {
    const input = '<action id=" spaced "> Padded Label </action>';
    const { actions } = extractActions(input);
    expect(actions[0].id).toBe("spaced");
    expect(actions[0].label).toBe("Padded Label");
  });
});

describe("stripMetadata handles action tags", () => {
  test("converts action tags to bracketed labels in plain text", () => {
    const input = 'Alert!\n<action id="ack">Acknowledge</action>\n<action id="fix">Fix it</action>';
    const result = stripMetadata(input);
    expect(result).toContain("[Acknowledge]");
    expect(result).toContain("[Fix it]");
    expect(result).not.toContain("<action");
  });

  test("strips memory blocks and converts actions together", () => {
    const input = 'Text\n<action id="a">Click</action>\n\n<memory>\n- type: fact\n- topic: test\n- content: x\n- complete: true\n- context: sufficient\n- keywords: test\n</memory>';
    const result = stripMetadata(input);
    expect(result).toContain("[Click]");
    expect(result).not.toContain("<memory>");
  });
});

describe("action button rendering", () => {
  // Test that generateHtml includes action buttons when actions are provided
  // We test this indirectly through createView since generateHtml is private

  test("createView includes action buttons in HTML", () => {
    const { createView } = require("../src/views/renderer");
    const slug = createView({
      content: 'Report\n<action id="ack">Acknowledge</action>\n<action id="fix">Fix</action>',
      title: "Test Actions",
    });
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const html = readFileSync(join(__dirname, "..", "views", `${slug}.html`), "utf-8");
    expect(html).toContain("action-btn");
    expect(html).toContain("Acknowledge");
    expect(html).toContain("Fix");
    expect(html).toContain("data-action-id");
    expect(html).toContain("/api/action");

    // Clean up
    const { unlinkSync } = require("fs");
    try { unlinkSync(join(__dirname, "..", "views", `${slug}.html`)); } catch {}
  });

  test("createView without actions has no action bar", () => {
    const { createView } = require("../src/views/renderer");
    const slug = createView({
      content: "Just plain content, no actions",
      title: "No Actions",
    });
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const html = readFileSync(join(__dirname, "..", "views", `${slug}.html`), "utf-8");
    expect(html).not.toContain('id="action-bar"');
    expect(html).not.toContain("data-action-id");

    const { unlinkSync } = require("fs");
    try { unlinkSync(join(__dirname, "..", "views", `${slug}.html`)); } catch {}
  });
});
