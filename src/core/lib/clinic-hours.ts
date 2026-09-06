import { z } from "zod";
import {
  describeWeeklyHours,
  TIME_RE,
  timeToMinutes,
  WEEKDAYS,
} from "@/core/lib/availability";

/**
 * The clinic's OPENING HOURS — CORE, pure (no server-only import, so the editor and
 * the server share one definition).
 *
 * One row per window, exactly like `users.availability` minus its `kind`. A weekday
 * with no rows is CLOSED, and several rows for one weekday is a split shift — which
 * is the case that decides the shape: a Friday that breaks for Jummah and reopens is
 * normal here, so "one start and one end per day" would have been wrong from the
 * start.
 *
 * DISPLAY-ONLY. These hours are what the clinic says about itself; they drive nothing.
 * Bookability comes from each doctor's own `availability` via `checkDoctorSlot`, and
 * the WhatsApp reply prints both so the clinic's words can never mislead about when a
 * patient can actually be seen.
 */
export type ClinicHour = { weekday: number; start: string; end: string };

const WEEKDAY_VALUES = WEEKDAYS.map((d) => d.value);

/**
 * Parse hours arriving as `jsonb` from a browser. Conventions §4: jsonb is not an
 * exemption from validation — an unbounded object from a client is both a storage
 * abuse vector and arbitrary structure in the record.
 *
 * Returns [] for anything unusable rather than throwing: the worst case for a
 * display-only field is showing nothing, and a clinic locked out of its own settings
 * page by a malformed row would be a far worse failure than a blank line.
 */
const hourSchema = z.object({
  weekday: z.number().int().refine((v) => WEEKDAY_VALUES.includes(v), "Unknown weekday"),
  start: z.string().regex(TIME_RE, "Times must be HH:MM"),
  end: z.string().regex(TIME_RE, "Times must be HH:MM"),
});

/** At most 3 windows a day × 7 days. A cap, not a guess: it bounds what a client can store. */
const MAX_WINDOWS = 21;

export const clinicHoursSchema = z
  .array(hourSchema)
  .max(MAX_WINDOWS)
  // An end at or before its start is not a window; it is a typo that would render as
  // "10:00 AM – 10:00 AM" and tell a patient nothing.
  .refine((rows) => rows.every((r) => (timeToMinutes(r.start) ?? 0) < (timeToMinutes(r.end) ?? 0)), {
    message: "Each opening time must end after it starts.",
  });

export function parseClinicHours(value: unknown): ClinicHour[] {
  const r = clinicHoursSchema.safeParse(value);
  return r.success ? r.data : [];
}

/** The windows for one weekday, in start order. Empty = closed that day. */
export function windowsForDay(hours: readonly ClinicHour[], weekday: number): ClinicHour[] {
  return hours
    .filter((h) => h.weekday === weekday)
    .sort((a, b) => (timeToMinutes(a.start) ?? 0) - (timeToMinutes(b.start) ?? 0));
}

/**
 * The clinic's hours as a patient reads them — grouped, with closed days named.
 * The wording and grouping live in `describeWeeklyHours` so a doctor's hours and a
 * clinic's are formatted by one function rather than two that drift.
 */
export function describeClinicHours(hours: readonly ClinicHour[]): string {
  return describeWeeklyHours(hours, { showClosed: true });
}
