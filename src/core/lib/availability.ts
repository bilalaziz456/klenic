/**
 * Doctor availability + daily capacity — CORE, specialty-agnostic. Every
 * specialty's doctors keep working hours and a per-day appointment cap, so this
 * lives in core (not a module). Pure and isomorphic (usable from client + server
 * — no "server-only"): the schedule editor and the booking guard share it.
 *
 * Weekdays use the JS convention: 0 = Sunday … 6 = Saturday (Date.getDay()).
 */

/**
 * What a window is for. A doctor may consult 9–12 and keep a separate afternoon
 * slot for procedures, which take longer and often need a chair or an assistant.
 *
 * Free-text-ish rather than an enum because `availability` is jsonb: an OLD
 * window has no `kind` at all and must keep behaving exactly as it did, so
 * absent reads as "consultation" everywhere (see `windowKind`).
 */
export type WindowKind = "consultation" | "procedure";

/** One working window on a given weekday, e.g. Mon 09:00–17:00. */
export type DayAvailability = {
  weekday: number;
  start: string;
  end: string;
  /** Absent = consultation, so schedules saved before this existed are unchanged. */
  kind?: WindowKind;
};

/** A window's purpose, defaulting an untagged (pre-existing) window to consultation. */
export function windowKind(w: DayAvailability): WindowKind {
  return w.kind === "procedure" ? "procedure" : "consultation";
}

export const WINDOW_KINDS: { value: WindowKind; label: string }[] = [
  { value: "consultation", label: "Consultation" },
  { value: "procedure", label: "Procedure" },
];

/**
 * Which window kinds a visit may be booked into. A visit carrying procedure
 * lines fits either — the patient is in the chair once, and the clinic's rule is
 * that a procedure may run inside consulting hours or in its own slot. A pure
 * consultation may only use a consultation window.
 */
export function allowedKindsFor(hasProcedures: boolean): WindowKind[] {
  return hasProcedures ? ["consultation", "procedure"] : ["consultation"];
}

/** Display order (Mon first) with labels. `value` is the JS getDay() number. */
export const WEEKDAYS: { value: number; label: string; short: string }[] = [
  { value: 1, label: "Monday", short: "Mon" },
  { value: 2, label: "Tuesday", short: "Tue" },
  { value: 3, label: "Wednesday", short: "Wed" },
  { value: 4, label: "Thursday", short: "Thu" },
  { value: 5, label: "Friday", short: "Fri" },
  { value: 6, label: "Saturday", short: "Sat" },
  { value: 0, label: "Sunday", short: "Sun" },
];

/** "HH:MM" 24-hour. */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function timeToMinutes(hhmm: string): number | null {
  if (!TIME_RE.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** "09:30" → "9:30 AM", for reading a working window back to a patient. */
export function formatTime12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const meridiem = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${meridiem}`;
}

/**
 * ALL of the doctor's working windows for a JS weekday (0=Sun..6=Sat), in list
 * order and regardless of kind.
 *
 * The order matters beyond display: `queueSessionKey` identifies a session by a
 * window's INDEX in this result (`w{idx}`). Never filter here — narrowing the
 * list would renumber existing sessions and collide live queue tokens. Use
 * `windowsOfKind` when you only want one purpose.
 */
export function windowsForWeekday(
  availability: DayAvailability[],
  weekday: number,
): DayAvailability[] {
  return availability.filter((a) => a.weekday === weekday);
}

/** A weekday's windows narrowed to the given purposes (display + validation). */
export function windowsOfKind(
  availability: DayAvailability[],
  weekday: number,
  kinds: WindowKind[],
): DayAvailability[] {
  return windowsForWeekday(availability, weekday).filter((w) =>
    kinds.includes(windowKind(w)),
  );
}

/** The doctor's FIRST window for a weekday, if any (convenience). */
export function availabilityForWeekday(
  availability: DayAvailability[],
  weekday: number,
): DayAvailability | undefined {
  return availability.find((a) => a.weekday === weekday);
}

/**
 * Is the doctor available at this instant? An EMPTY schedule means no restriction
 * (bookable any time) — availability is opt-in per doctor. Otherwise the time
 * must fall within ANY of the weekday's windows (a day can have several, e.g.
 * 09:00–12:00 and 16:00–19:00).
 *
 * `kinds` narrows which purposes count. Omitted, every window counts — so a
 * caller that doesn't care about purpose behaves exactly as before this existed.
 */
export function isDoctorAvailableAt(
  availability: DayAvailability[],
  when: Date,
  kinds?: WindowKind[],
): boolean {
  if (!availability || availability.length === 0) return true;
  const t = when.getHours() * 60 + when.getMinutes();
  const windows = kinds
    ? windowsOfKind(availability, when.getDay(), kinds)
    : windowsForWeekday(availability, when.getDay());
  return windows.some((w) => {
    const s = timeToMinutes(w.start);
    const e = timeToMinutes(w.end);
    return s !== null && e !== null && t >= s && t < e;
  });
}

/**
 * Human-readable summary, e.g. "Mon 09:00–12:00, 16:00–19:00 (proc); Tue
 * 10:00–14:00" or "Any time". Days are separated by "; " since each day may list
 * several windows separated by ", ". Procedure windows are marked; consultation
 * is the unmarked default, so a doctor who never uses the split reads as before.
 */
export function describeAvailability(availability: DayAvailability[]): string {
  if (!availability || availability.length === 0) return "Any time";
  return WEEKDAYS.filter(
    (d) => windowsForWeekday(availability, d.value).length > 0,
  )
    .map((d) => {
      const windows = windowsForWeekday(availability, d.value)
        .map(
          (w) =>
            `${w.start}–${w.end}${windowKind(w) === "procedure" ? " (proc)" : ""}`,
        )
        .join(", ");
      return `${d.short} ${windows}`;
    })
    .join("; ");
}

/** A weekly window, independent of whose it is: a doctor's or the clinic's own. */
export type WeeklyWindow = { weekday: number; start: string; end: string };

/**
 * Weekly hours as a person reads them, with CONSECUTIVE days that have identical
 * hours collapsed:
 *
 *   Mon – Thu: 10:00 AM – 9:00 PM
 *   Fri: 10:00 AM – 1:00 PM, 3:00 PM – 11:00 PM
 *   Sat: 10:00 AM – 10:00 PM
 *   Sun: Closed
 *
 * Collapsing is not decoration — it is how opening hours are read everywhere else,
 * and seven near-identical lines is the kind of wall people skip in a WhatsApp
 * message. Runs merge only when ADJACENT in `WEEKDAYS` order (Monday first, Sunday
 * last), so a Tue/Thu-only clinic is never described as "Tue – Thu".
 *
 * `showClosed` is the one difference between the two callers, and it matters. A
 * CLINIC states "Sun: Closed" because a patient wants to know. A DOCTOR is simply
 * not listed on a day they do not work — "Dr Bilal, Sun: Closed" reads as though the
 * clinic is shut, which it may not be. Same grouping, different silence.
 *
 * Lives here rather than beside either caller so there is exactly ONE definition of
 * how hours are worded; `core/lib/clinic-hours.ts` imports it, not the other way
 * round, which is also what keeps the two modules acyclic.
 */
export function describeWeeklyHours(
  windows: readonly WeeklyWindow[],
  opts: { showClosed?: boolean } = {},
): string {
  if (windows.length === 0) return "";
  const showClosed = opts.showClosed ?? true;
  const dayText = (weekday: number): string => {
    const w = windows
      .filter((h) => h.weekday === weekday)
      .sort((a, b) => (timeToMinutes(a.start) ?? 0) - (timeToMinutes(b.start) ?? 0));
    if (w.length === 0) return "Closed";
    return w.map((r) => `${formatTime12(r.start)} – ${formatTime12(r.end)}`).join(", ");
  };

  // GROUP FIRST, THEN DROP — never the other way round.
  //
  // Filtering closed days out before grouping makes NON-ADJACENT days adjacent: a
  // doctor working Mon and Thu only had Tue and Wed removed, so the two survivors sat
  // next to each other and merged into "Mon – Thu" — telling patients he works two
  // days he does not. Runs are built across the whole week, where a closed day breaks
  // a run, and only then are the closed runs dropped.
  const rows = WEEKDAYS.map((d) => ({ short: d.short, text: dayText(d.value) }));
  const runs: { from: string; to: string; text: string }[] = [];
  for (const r of rows) {
    const last = runs[runs.length - 1];
    if (last && last.text === r.text) last.to = r.short;
    else runs.push({ from: r.short, to: r.short, text: r.text });
  }
  return runs
    .filter((run) => showClosed || run.text !== "Closed")
    .map((run) => `${run.from === run.to ? run.from : `${run.from} – ${run.to}`}: ${run.text}`)
    .join("\n");
}

/**
 * A doctor's CONSULTATION hours, in a form a patient can read.
 *
 * Procedure windows are excluded, and not merely unlabelled: a patient told "Mon
 * 4–8pm" who arrives for a consultation during a procedure window has been
 * misinformed by us. The staff-facing `describeAvailability` above keeps them, marked
 * "(proc)", which is internal vocabulary a patient would not understand.
 */
export function describeConsultationHours(availability: DayAvailability[]): string {
  if (!availability || availability.length === 0) return "";
  const windows = WEEKDAYS.flatMap((d) =>
    windowsOfKind(availability, d.value, ["consultation"]).map((w) => ({
      weekday: d.value,
      start: w.start,
      end: w.end,
    })),
  );
  return describeWeeklyHours(windows, { showClosed: false });
}

/** Appointment statuses that consume a slot toward the daily limit. */
export const ACTIVE_APPT_STATUSES = [
  "scheduled",
  "confirmed",
  "arrived",
  "in_progress",
  "completed",
] as const;

/** Local-midnight day bounds [start, nextDay) for counting a doctor's day. */
export function dayBounds(when: Date): { start: Date; end: Date } {
  const start = new Date(when.getFullYear(), when.getMonth(), when.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}
