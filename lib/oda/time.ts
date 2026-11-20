/**
 * ODA timestamps carry no offset (e.g. `2026-11-18T14:31:51.75`). They are
 * Danish local time, so they are read as `Europe/Copenhagen` wall-clock time
 * and converted to a UTC instant (spec 002, Context).
 *
 * Wall-clock times that are ambiguous or do not exist because of a daylight
 * saving transition are resolved like Temporal's `"compatible"`
 * disambiguation:
 *
 * - Ambiguous (autumn, 02:00 to 03:00 happens twice): the earlier instant,
 *   in summer time (+02:00).
 * - Nonexistent (spring, 02:00 to 03:00 is skipped): the wall time is read
 *   with the offset before the transition (+01:00), so 02:30 becomes 01:30Z,
 *   which is 03:30 summer time.
 */

const timeZone = "Europe/Copenhagen";

const timestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/;

const hourMs = 60 * 60 * 1000;

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

/** The Copenhagen UTC offset in milliseconds at the given instant. */
function offsetAt(instant: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(instant))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const wallClock = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Whole seconds only: the formatter drops milliseconds.
  return wallClock - Math.floor(instant / 1000) * 1000;
}

/**
 * Parses an ODA timestamp as `Europe/Copenhagen` local time. Returns
 * `undefined` if the text is not a valid offset-free timestamp.
 */
export function tryParseOdaTimestamp(text: string): Date | undefined {
  const match = timestampPattern.exec(text);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  // Fractions have up to seven digits; milliseconds keep the first three.
  const millisecond = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));

  // The wall-clock time read as if it were UTC.
  const local = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond,
  );
  const check = new Date(local);
  if (
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return undefined;
  }

  // Transitions are months apart, so at most one lies within 12 hours.
  const offsetBefore = offsetAt(local - 12 * hourMs);
  const offsetAfter = offsetAt(local + 12 * hourMs);
  const candidates = [offsetBefore, offsetAfter]
    .map((offset) => local - offset)
    .filter((instant) => local - offsetAt(instant) === instant);

  if (candidates.length === 0) {
    // Nonexistent wall time: use the offset before the transition.
    return new Date(local - offsetBefore);
  }
  // One valid instant, or two for an ambiguous time: take the earlier.
  return new Date(Math.min(...candidates));
}

/** Like `tryParseOdaTimestamp()`, but throws a fixed `RangeError`. */
export function parseOdaTimestamp(text: string): Date {
  const date = tryParseOdaTimestamp(text);
  if (!date) throw new RangeError("invalid ODA timestamp");
  return date;
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/**
 * Formats a UTC instant as an ODA timestamp: `Europe/Copenhagen` wall-clock
 * time without offset or fraction, e.g. `2026-11-18T14:31:51`, for filters
 * such as `opdateringsdato gt datetime'2026-11-18T14:31:51'`. Milliseconds
 * are dropped (rounded down), so the literal is never later than the instant.
 *
 * During the autumn transition one local hour occurs twice, so instants an
 * hour apart can format the same. Callers that filter by watermark start an
 * hour before it (spec 002, deliverable 4), which absorbs this.
 */
export function formatOdaTimestamp(instant: Date): string {
  const time = instant.getTime();
  if (Number.isNaN(time)) throw new RangeError("invalid date");
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}
