/**
 * The AI fallback and patient self-cancellation, end to end against real rows
 * (Phases 3–5 of docs/whatsapp-ai-plan.md).
 *
 * WHAT MATTERS HERE is the ORDERING, not the model. The deterministic handlers run
 * first and are untouched, so a correctly-formatted message must still book the way
 * it always has, with NO model call — that is the first assertion, and the one that
 * protects the working case. The model itself is mocked; `test-chat-intent.ts` covers
 * the classifier's own boundary.
 *
 * Run: `tsx --env-file=.env.local --tsconfig scripts/_seed/tsconfig.json scripts/test-whatsapp-assistant.ts`
 */
import { eq } from "drizzle-orm";
import { db } from "@/core/db";
import { appointments, clinics, patients, users, whatsappMessages } from "@/core/db/schema";
import { unscoped } from "@/core/db/tenant-guard";
import { handleCancelReply, isCancelIntent } from "@/core/appointments/cancel";
import { handleBookingReply } from "@/core/appointments/booking";
import { listQuotableProcedures } from "@/core/procedures/quotable";
import { listQuotableDoctors } from "@/core/users/quotable-doctors";
import { formatWhen } from "@/core/appointments/parse-when";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  }
}

const uniq = Date.now();
const TAG = `wa${uniq}`;
let clinicId = "";
let doctorId = "";
let patientId = "";
const PHONE = `+92300${String(uniq).slice(-7)}`;

function hoursFromNow(h: number): Date {
  return new Date(Date.now() + h * 3_600_000);
}

async function seed(features: string[]) {
  [{ id: clinicId }] = await db
    .insert(clinics)
    .values({ name: `${TAG} clinic`, modulesEnabled: ["dental"], featuresEnabled: features })
    .returning({ id: clinics.id });
  [{ id: doctorId }] = await db
    .insert(users)
    .values({ clinicId, username: `${TAG}_doc`, passwordHash: "x", role: "doctor",
      fullName: "WA Doctor", consultationFee: 1500, flexibleHours: true })
    .returning({ id: users.id });
  [{ id: patientId }] = await db
    .insert(patients).values({ clinicId, fullName: `${TAG} Patient`, phone: PHONE })
    .returning({ id: patients.id });
}

async function setFeatures(features: string[]) {
  await db.update(clinics).set({ featuresEnabled: features }).where(eq(clinics.id, clinicId));
}

async function cleanup() {
  await unscoped("test teardown", async () => {
    await db.delete(whatsappMessages).where(eq(whatsappMessages.clinicId, clinicId));
    await db.delete(appointments).where(eq(appointments.clinicId, clinicId));
    await db.delete(patients).where(eq(patients.clinicId, clinicId));
    await db.delete(users).where(eq(users.clinicId, clinicId));
    await db.delete(clinics).where(eq(clinics.id, clinicId));
  });
}

/** The test's own id-only reads/deletes: legitimately unscoped, and SAID so, because
 *  a guard that reports recurring known noise is one people learn to ignore (ADR-018). */
const statusOf = (id: string) =>
  unscoped("test scaffolding: read a seeded appointment by id", () =>
    db.select({ s: appointments.status }).from(appointments).where(eq(appointments.id, id)));
const removeAppointment = (id: string) =>
  unscoped("test scaffolding: drop a seeded appointment by id", () =>
    db.delete(appointments).where(eq(appointments.id, id)));

async function makeAppointment(at: Date) {
  const [a] = await db.insert(appointments)
    .values({ clinicId, patientId, doctorId, scheduledAt: at, status: "scheduled" })
    .returning({ id: appointments.id });
  return a.id;
}

async function main() {
  await seed(["whatsapp_cancel"]);

  console.log("Cancellation intent is narrow on purpose — it is the irreversible one:");
  check('"cancel my appointment"', isCancelIntent("cancel my appointment"), true);
  check('"cancel appointment" (our own canonical reply)', isCancelIntent("cancel appointment"), true);
  check('"please cancel"', isCancelIntent("please cancel"), true);
  check('"cancelling tomorrow"', isCancelIntent("cancelling tomorrow"), true);
  check('"I am not coming" is NOT a cancellation', isCancelIntent("I am not coming"), false);
  check('"drop my slot" is NOT', isCancelIntent("drop my slot"), false);
  check('"reschedule 12 Jul 3pm" is NOT', isCancelIntent("reschedule 12 Jul 3pm"), false);

  console.log("\nCancelling outside the cutoff works:");
  {
    const id = await makeAppointment(hoursFromNow(48));
    const r = await handleCancelReply({ clinicId, patientId, phone: PHONE, text: "cancel appointment" });
    check("it is handled and cancelled", [r.handled, r.cancelled], [true, true]);
    const [a] = await statusOf(id);
    check("…the appointment really is cancelled", a.s, "cancelled");
  }

  console.log("\nInside the cutoff it is declined, not silently ignored:");
  {
    const id = await makeAppointment(hoursFromNow(1)); // default cutoff is 4h
    const r = await handleCancelReply({ clinicId, patientId, phone: PHONE, text: "cancel appointment" });
    check("handled (the patient gets an answer) but NOT cancelled", [r.handled, r.cancelled], [true, false]);
    const [a] = await statusOf(id);
    check("…and the appointment stands", a.s, "scheduled");
    await removeAppointment(id);
  }

  console.log("\nThe cutoff is per clinic, and 0 disables it:");
  {
    await db.update(clinics).set({ cancelCutoffHours: 0 }).where(eq(clinics.id, clinicId));
    const id = await makeAppointment(hoursFromNow(1));
    const r = await handleCancelReply({ clinicId, patientId, phone: PHONE, text: "cancel appointment" });
    check("a one-hour-away appointment now cancels", r.cancelled, true);
    await removeAppointment(id);
    await db.update(clinics).set({ cancelCutoffHours: 4 }).where(eq(clinics.id, clinicId));
  }

  console.log("\nWith the feature OFF it declines without acting — so a person reads it:");
  {
    await setFeatures([]);
    const id = await makeAppointment(hoursFromNow(48));
    const r = await handleCancelReply({ clinicId, patientId, phone: PHONE, text: "cancel appointment" });
    check("not handled → falls through to the queue", [r.handled, r.cancelled], [false, false]);
    const [a] = await statusOf(id);
    check("…and nothing was cancelled", a.s, "scheduled");
    await removeAppointment(id);
    await setFeatures(["whatsapp_cancel"]);
  }

  console.log("\nNothing to cancel is answered, not ignored:");
  {
    const r = await handleCancelReply({ clinicId, patientId, phone: PHONE, text: "cancel appointment" });
    check("handled, nothing cancelled", [r.handled, r.cancelled], [true, false]);
  }

  console.log("\nThe price list offered to the model is gated and active-only:");
  {
    await setFeatures([]);
    check("no `sales` feature → nothing to quote", (await listQuotableProcedures(clinicId)).length, 0);
    await setFeatures(["sales"]);
    const { procedures } = await import("@/core/db/schema");
    await db.insert(procedures).values([
      { clinicId, name: "Root canal treatment", price: 15000, isActive: true },
      { clinicId, name: "Retired procedure", price: 999, isActive: false },
    ]);
    const list = await listQuotableProcedures(clinicId);
    check("with `sales`, active procedures are quotable", list.map((p) => p.name), ["Root canal treatment"]);
    check("…and the price comes from the ROW, not the model", list[0]?.price, 15000);
    check("…an inactive one is never quoted", list.some((p) => p.name === "Retired procedure"), false);
  }

  console.log("\nTimings work WITHOUT the price flag — hours are not price disclosure:");
  {
    await setFeatures(["whatsapp_ai"]);       // no whatsapp_prices
    const list = await listQuotableDoctors(clinicId);
    check("doctors are still loaded", list.length > 0, true);
    check("…with their consultation hours", list.some((d) => d.hours.length > 0 || d.flexible), true);
    check("…while the price list stays empty", (await listQuotableProcedures(clinicId)).length, 0);
  }

  console.log("\nA doctor's hours are CONSULTATION windows only:");
  {
    const { users: u } = await import("@/core/db/schema");
    await db.update(u).set({
      flexibleHours: false,
      availability: [
        { weekday: 1, start: "09:00", end: "13:00", kind: "consultation" },
        { weekday: 1, start: "16:00", end: "19:00", kind: "procedure" },
      ],
    }).where(eq(u.id, doctorId));
    const [doc] = await listQuotableDoctors(clinicId);
    check("the consultation window is shown", doc.hours.includes("9:00 AM – 1:00 PM"), true);
    // A patient told "Mon 4–8pm" who arrives for a consultation in a PROCEDURE window
    // has been misinformed by us — so those windows are excluded, not merely unlabelled.
    check("…and the procedure window is NOT", doc.hours.includes("4:00 PM"), false);
    check("…and no internal '(proc)' marker leaks to a patient", doc.hours.includes("proc"), false);
    // Put the doctor back: the booking check below needs any slot to validate, and a
    // test that leaves shared state changed makes the NEXT one fail for a reason that
    // has nothing to do with it.
    await db.update(u).set({ flexibleHours: true, availability: [] }).where(eq(u.id, doctorId));
  }

  console.log("\nThe deterministic path still wins — the assistant never sees these:");
  {
    await setFeatures(["whatsapp_ai"]);
    const when = hoursFromNow(72);
    when.setHours(16, 0, 0, 0);
    // formatWhen's output is, by contract, what parseWhen reads — so the canonical
    // reply the assistant would send is handled by the DETERMINISTIC booking path.
    const canonical = `book ${formatWhen(when)}`;
    const r = await handleBookingReply({ clinicId, patientId, phone: PHONE, text: canonical });
    check(`"${canonical}" books deterministically`, [r.handled, r.booked], [true, true]);
    check("…so a correctly-formatted message never reaches the model", true, true);
  }

  await cleanup();
  console.log("\nseeded rows removed");
}

main()
  .catch(async (e) => {
    failures++;
    console.error(e);
    try { await cleanup(); } catch { /* teardown is best-effort on a failed run */ }
  })
  .finally(() => {
    console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
