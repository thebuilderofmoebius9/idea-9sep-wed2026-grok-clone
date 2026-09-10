import test from "node:test";
import assert from "node:assert/strict";
import { dueWindow, localInstant, nextRun, occurrenceID } from "../src/routines.mjs";

const bangkok = "Asia/Bangkok";
const newYork = "America/New_York";

test("interval recurrence advances by whole minutes", () => {
  const start = Date.UTC(2026, 8, 10, 3, 0, 0);
  assert.equal(nextRun(start, { type: "interval", minutes: 45 }, bangkok), start + 45 * 60_000);
});

test("an interval under five minutes or a bad daily time is refused", () => {
  const start = Date.UTC(2026, 8, 10);
  assert.throws(() => nextRun(start, { type: "interval", minutes: 4 }, bangkok), /routine/);
  assert.throws(() => nextRun(start, { type: "daily", hour: 24, minute: 0 }, bangkok), /routine/);
  assert.throws(() => nextRun(start, { type: "daily", hour: 9, minute: 0 }, "Mars/Olympus"), /routine/);
});

test("a daily trigger resolves in its own zone, not the host zone", () => {
  const nine = localInstant(2026, 9, 10, 9, 0, bangkok);
  assert.equal(new Date(nine).toISOString(), "2026-09-10T02:00:00.000Z");
  assert.equal(nextRun(nine, { type: "daily", hour: 9, minute: 0 }, bangkok),
    localInstant(2026, 9, 11, 9, 0, bangkok));
  const before = nine - 60_000;
  assert.equal(nextRun(before, { type: "daily", hour: 9, minute: 0 }, bangkok), nine);
});

test("a local time inside a spring-forward gap resolves to the transition instant", () => {
  const gap = localInstant(2026, 3, 8, 2, 30, newYork);
  assert.equal(new Date(gap).toISOString(), "2026-03-08T07:00:00.000Z");
});

test("a repeated fall-back local time resolves to the first occurrence", () => {
  const repeated = localInstant(2026, 11, 1, 1, 30, newYork);
  assert.equal(new Date(repeated).toISOString(), "2026-11-01T05:30:00.000Z", "ต้องเป็นครั้งแรก (EDT) ไม่ใช่ครั้งที่สอง");
});

test("a missed interval window reports one catch-up plus an aggregate, never a run per miss", () => {
  const first = Date.UTC(2026, 8, 10, 0, 0, 0);
  const window = dueWindow(first, first + 3 * 3_600_000, { type: "interval", minutes: 30 }, bangkok);
  assert.equal(window.skippedCount, 6);
  assert.equal(window.latest, first + 6 * 30 * 60_000);
  assert.equal(window.next, window.latest + 30 * 60_000);
  assert.equal(window.firstSkippedAt, first);
  assert.equal(window.lastSkippedAt, window.latest - 30 * 60_000);
});

test("a missed daily window counts whole local days", () => {
  const first = localInstant(2026, 9, 1, 9, 0, bangkok);
  const now = localInstant(2026, 9, 10, 12, 0, bangkok);
  const window = dueWindow(first, now, { type: "daily", hour: 9, minute: 0 }, bangkok);
  assert.equal(window.skippedCount, 9);
  assert.equal(window.latest, localInstant(2026, 9, 10, 9, 0, bangkok));
  assert.equal(window.next, localInstant(2026, 9, 11, 9, 0, bangkok));
});

test("nothing is due before the first occurrence and the latest is never in the future", () => {
  const first = localInstant(2026, 9, 10, 9, 0, bangkok);
  assert.equal(dueWindow(first, first - 1, { type: "daily", hour: 9, minute: 0 }, bangkok), null);
  const window = dueWindow(first, first, { type: "daily", hour: 9, minute: 0 }, bangkok);
  assert.equal(window.latest, first);
  assert.equal(window.skippedCount, 0);
  assert.ok(window.next > first);
});

test("a persisted daily watermark that is not a real occurrence is refused", () => {
  const offGrid = localInstant(2026, 9, 1, 9, 0, bangkok) + 90_000;
  assert.throws(() => dueWindow(offGrid, offGrid + 86_400_000, { type: "daily", hour: 9, minute: 0 }, bangkok), /routine/);
});

test("occurrence identity dedupes a daily run per local day and an interval run per instant", () => {
  const morning = localInstant(2026, 9, 10, 9, 0, bangkok);
  const daily = { type: "daily", hour: 9, minute: 0 };
  assert.equal(occurrenceID("s", morning, daily, bangkok), "s:day-2026-9-10");
  assert.equal(occurrenceID("s", morning, daily, bangkok), occurrenceID("s", morning, daily, bangkok));
  assert.notEqual(
    occurrenceID("s", morning, { type: "interval", minutes: 30 }, bangkok),
    occurrenceID("s", morning + 30 * 60_000, { type: "interval", minutes: 30 }, bangkok));
});
