// Pure recurrence arithmetic ported from RoutineSchedule.swift.
// It never reads a clock and never starts work: callers supply every instant.

import { WorkspaceError, fail, isValidTimezone, validTrigger } from "./domain.mjs";

const MINUTE = 60_000;
const DAY = 86_400_000;

function zonedParts(instant, timezoneID) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: timezoneID,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = {};
  for (const { type, value } of format.formatToParts(new Date(instant))) {
    if (type !== "literal") parts[type] = Number(value);
  }
  // Intl renders midnight as hour 24 in some ICU builds.
  if (parts.hour === 24) parts.hour = 0;
  return parts;
}

// Zone offsets are whole seconds. Aligning the probe keeps a sub-second remainder from
// making two instants inside the same offset window look like a transition.
const offsetMS = (instant, timezoneID) => {
  const aligned = Math.floor(instant / 1000) * 1000;
  const parts = zonedParts(aligned, timezoneID);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - aligned;
};

const sameCivil = (instant, timezoneID, year, month, day, hour, minute) => {
  const parts = zonedParts(instant, timezoneID);
  return parts.year === year && parts.month === month && parts.day === day
    && parts.hour === hour && parts.minute === minute && parts.second === 0;
};

/**
 * The instant for one local civil time in a zone.
 * Repeated times during fall-back resolve to the first occurrence; a spring-forward gap
 * resolves to the first valid instant of the transition rather than silently shifting a day.
 */
export function localInstant(year, month, day, hour, minute, timezoneID) {
  if (!isValidTimezone(timezoneID)) fail("invalidRoutine");
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const candidates = new Set();
  for (const probe of [guess, guess - offsetMS(guess, timezoneID)]) {
    candidates.add(guess - offsetMS(probe, timezoneID));
  }
  const valid = [...candidates].filter((instant) =>
    sameCivil(instant, timezoneID, year, month, day, hour, minute));
  if (valid.length > 0) return Math.min(...valid);

  // The requested local time does not exist. Prove a forward offset transition covers it
  // inside that local day and return the transition instant itself.
  const dayStart = Date.UTC(year, month - 1, day) - offsetMS(Date.UTC(year, month - 1, day), timezoneID);
  let low = dayStart - DAY;
  let high = dayStart + 2 * DAY;
  const startOffset = offsetMS(low, timezoneID);
  if (offsetMS(high, timezoneID) === startOffset) fail("invalidRoutine");
  while (high - low > 1000) {
    const middle = low + Math.floor((high - low) / 2000) * 1000;
    if (middle <= low || middle >= high) break;
    if (offsetMS(middle, timezoneID) === startOffset) low = middle; else high = middle;
  }
  if (offsetMS(high, timezoneID) <= startOffset) fail("invalidRoutine");
  const before = zonedParts(low, timezoneID);
  const after = zonedParts(high, timezoneID);
  const target = [year, month, day, hour, minute, 0];
  const key = (parts) => [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second];
  const precedes = (left, right) => {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return left[index] < right[index];
    }
    return false;
  };
  if (!precedes(key(before), target) || !precedes(target, key(after))) fail("invalidRoutine");
  return high;
}

/// The daily occurrence for the local day containing `instant`.
function dailyOccurrenceOnDayOf(instant, hour, minute, timezoneID) {
  const parts = zonedParts(instant, timezoneID);
  return localInstant(parts.year, parts.month, parts.day, hour, minute, timezoneID);
}

const shiftLocalDays = (instant, days, timezoneID) => {
  const parts = zonedParts(instant, timezoneID);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
};

export function nextRun(after, trigger, timezoneID) {
  const rule = validTrigger(trigger);
  if (!isValidTimezone(timezoneID)) fail("invalidRoutine");
  if (!Number.isFinite(after)) fail("invalidRoutine");
  if (rule.type === "interval") return after + rule.minutes * MINUTE;
  const today = dailyOccurrenceOnDayOf(after, rule.hour, rule.minute, timezoneID);
  if (today > after) return today;
  const tomorrow = shiftLocalDays(after, 1, timezoneID);
  return localInstant(tomorrow.year, tomorrow.month, tomorrow.day, rule.hour, rule.minute, timezoneID);
}

/**
 * One catch-up candidate plus an aggregate of older missed occurrences.
 * Deliberately no loop per missed run: a laptop asleep for a month must not queue 40k runs.
 */
export function dueWindow(first, now, trigger, timezoneID) {
  const rule = validTrigger(trigger);
  if (!isValidTimezone(timezoneID)) fail("invalidRoutine");
  if (!Number.isFinite(first) || !Number.isFinite(now)) fail("invalidRoutine");
  if (first > now) return null;

  let latest;
  let skippedCount;
  let lastSkippedAt = null;
  if (rule.type === "interval") {
    const span = rule.minutes * MINUTE;
    skippedCount = Math.floor((now - first) / span);
    latest = first + skippedCount * span;
    if (skippedCount > 0) lastSkippedAt = latest - span;
  } else {
    // A persisted daily occurrence must be the first matching local time, not an arbitrary instant.
    if (dailyOccurrenceOnDayOf(first, rule.hour, rule.minute, timezoneID) !== first) {
      fail("invalidRoutine");
    }
    let day = zonedParts(now, timezoneID);
    let candidate = localInstant(day.year, day.month, day.day, rule.hour, rule.minute, timezoneID);
    if (candidate > now) {
      const previous = shiftLocalDays(now, -1, timezoneID);
      day = { ...day, ...previous };
      candidate = localInstant(previous.year, previous.month, previous.day, rule.hour, rule.minute, timezoneID);
    }
    if (candidate < first) fail("invalidRoutine");
    latest = candidate;
    const firstDay = zonedParts(first, timezoneID);
    skippedCount = Math.round(
      (Date.UTC(day.year, day.month - 1, day.day) - Date.UTC(firstDay.year, firstDay.month - 1, firstDay.day)) / DAY);
    if (skippedCount < 0) fail("invalidRoutine");
    if (skippedCount > 0) {
      const previous = shiftLocalDays(latest, -1, timezoneID);
      lastSkippedAt = localInstant(previous.year, previous.month, previous.day, rule.hour, rule.minute, timezoneID);
    }
  }
  const next = nextRun(latest, rule, timezoneID);
  if (latest > now || next <= now) fail("invalidRoutine");
  return {
    latest,
    next,
    skippedCount,
    firstSkippedAt: skippedCount > 0 ? first : null,
    lastSkippedAt,
  };
}

export function occurrenceID(scheduleID, instant, trigger, timezoneID) {
  const rule = validTrigger(trigger);
  if (rule.type === "interval") return `${scheduleID}:instant-${instant.toString(16)}`;
  const parts = zonedParts(instant, timezoneID);
  return `${scheduleID}:day-${parts.year}-${parts.month}-${parts.day}`;
}

export const routineFailureLabel = (code) => ({
  providerError: "ผู้ให้บริการตอบกลับผิดพลาด",
  missingCredential: "ยังไม่ได้ใส่ credential ของผู้ให้บริการในเซสชันนี้",
  missingProvider: "routine นี้ยังไม่ได้ผูกผู้ให้บริการ",
  missingBot: "บอทเจ้าของ routine ถูกลบไปแล้ว",
  cancelled: "ถูกยกเลิก",
  appQuit: "แอปปิดระหว่างรัน",
}[code] ?? code);

export { WorkspaceError };
