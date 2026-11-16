import { test } from "node:test";
import assert from "node:assert/strict";
import { startedTooLate, startDeadlineMs } from "./export-deadline.mjs";

const claimedAt = Date.parse("2026-11-16T17:28:10Z");
const at = (minutes) => claimedAt + minutes * 60 * 1000;

test("the start deadline is 30 minutes", () => {
  assert.equal(startDeadlineMs, 30 * 60 * 1000);
});

test("a pending job inside the deadline is not failed", () => {
  assert.equal(startedTooLate({ status: "pending", claimedAt, now: at(13) }), false);
  assert.equal(startedTooLate({ status: "pending", claimedAt, now: at(29) }), false);
});

test("a pending job past the deadline is failed", () => {
  assert.equal(startedTooLate({ status: "pending", claimedAt, now: at(31) }), true);
});

test("a running job is never failed by the start deadline", () => {
  assert.equal(startedTooLate({ status: "running", claimedAt, now: at(60) }), false);
  assert.equal(startedTooLate({ status: "complete", claimedAt, now: at(60) }), false);
});
