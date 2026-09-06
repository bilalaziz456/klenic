/**
 * Clinic opening hours — the structure, the validation and the wording.
 *
 * Pure: no database, no network. Run:
 *   `tsx --tsconfig scripts/_seed/tsconfig.json scripts/test-clinic-hours.ts`
 */
import { describeClinicHours, parseClinicHours, type ClinicHour } from "@/core/lib/clinic-hours";
import { describeWeeklyHours, describeConsultationHours } from "@/core/lib/availability";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  }
}

const w = (weekday: number, start: string, end: string): ClinicHour => ({ weekday, start, end });

console.log("A week with a split shift and a closed day:");
{
  const hours = [
    w(1, "10:00", "21:00"), w(2, "10:00", "21:00"), w(3, "10:00", "21:00"), w(4, "10:00", "21:00"),
    w(5, "10:00", "13:00"), w(5, "15:00", "23:00"),
    w(6, "10:00", "22:00"),
  ];
  check("consecutive identical days collapse", describeClinicHours(hours),
    "Mon – Thu: 10:00 AM – 9:00 PM\nFri: 10:00 AM – 1:00 PM, 3:00 PM – 11:00 PM\nSat: 10:00 AM – 10:00 PM\nSun: Closed");
}

console.log("\nGROUP FIRST, THEN DROP — the bug this pins:");
{
  // A doctor working Mon and Thu only. Filtering the closed days out BEFORE grouping
  // made the two survivors adjacent and merged them into "Mon – Thu", telling
  // patients he works two days he does not.
  const monThu = [w(1, "09:00", "17:00"), w(4, "09:00", "17:00")];
  check("Mon + Thu is never described as 'Mon – Thu'",
    describeWeeklyHours(monThu, { showClosed: false }),
    "Mon: 9:00 AM – 5:00 PM\nThu: 9:00 AM – 5:00 PM");
  check("…and genuinely consecutive days still DO collapse",
    describeWeeklyHours([1, 2, 3, 4].map((d) => w(d, "09:00", "17:00")), { showClosed: false }),
    "Mon – Thu: 9:00 AM – 5:00 PM");
  check("a clinic names its closed days", describeWeeklyHours(monThu, { showClosed: true }),
    "Mon: 9:00 AM – 5:00 PM\nTue – Wed: Closed\nThu: 9:00 AM – 5:00 PM\nFri – Sun: Closed");
}

console.log("\nA doctor's hours use the same wording, minus the closed days:");
{
  check("procedure windows are excluded, consultation kept",
    describeConsultationHours([
      { weekday: 1, start: "09:00", end: "13:00", kind: "consultation" },
      { weekday: 1, start: "16:00", end: "19:00", kind: "procedure" },
    ]),
    "Mon: 9:00 AM – 1:00 PM");
  check("nothing set reads as empty, for the caller to word", describeConsultationHours([]), "");
}

console.log("\njsonb from a browser is validated, never trusted (conventions §4):");
{
  check("a valid row survives", parseClinicHours([w(1, "10:00", "21:00")]), [w(1, "10:00", "21:00")]);
  check("end before start is rejected", parseClinicHours([w(1, "18:00", "09:00")]), []);
  check("end EQUAL to start is rejected", parseClinicHours([w(1, "09:00", "09:00")]), []);
  check("an unknown weekday is rejected", parseClinicHours([w(9, "09:00", "17:00")]), []);
  check("a non-HH:MM time is rejected", parseClinicHours([w(1, "9am", "5pm")]), []);
  check("a non-array is rejected", parseClinicHours({ weekday: 1 }), []);
  check("null is rejected", parseClinicHours(null), []);
  check("over the 21-window cap is rejected",
    parseClinicHours(Array.from({ length: 22 }, () => w(1, "09:00", "10:00"))), []);
  check("…and exactly 21 is allowed",
    parseClinicHours(Array.from({ length: 21 }, () => w(1, "09:00", "10:00"))).length, 21);
}

console.log("\nEmpty means 'not stated', which the reply omits:");
check("no hours renders as empty string", describeClinicHours([]), "");

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
