import "server-only";

import { serverEnv } from "@/core/lib/env";
import { getClinic } from "@/core/clinics/get-clinic";
import { clinicHasFeature } from "@/core/lib/features";
import { classifyMessage, worthClassifying, type ChatIntent } from "@/core/ai/chat-engine";
import { formatWhen } from "@/core/appointments/parse-when";
import { describeClinicHours, type ClinicHour } from "@/core/lib/clinic-hours";
import { getNextUpcomingAppointment } from "@/core/appointments/upcoming";
import { listQuotableProcedures } from "@/core/procedures/quotable";
import { listQuotableDoctors, type QuotableDoctor } from "@/core/users/quotable-doctors";
import { sendWhatsAppToPatient } from "@/core/notifications/whatsapp";
import { chatIntentByClinic, chatIntentByPhone } from "@/core/security/rate-limit";
import { report } from "@/core/observability";

/**
 * The AI fallback for inbound WhatsApp — CORE. Runs ONLY after the deterministic
 * handlers have declined, and only for a clinic with the `whatsapp_ai` feature.
 *
 * WHAT IT IS ALLOWED TO DO: reply with the patient's own request restated in the
 * format `parseWhen` reads, or with a price from the clinic's own list. That is all.
 * It never books, moves or cancels anything — the patient sends the restated message
 * back, and the DETERMINISTIC handler acts on it. A misreading therefore costs one
 * confusing message rather than a wrongly-moved appointment.
 *
 * See docs/whatsapp-ai-plan.md. The ordering is the safety property: this file cannot
 * run before the parser, and cannot write.
 */

export type AssistantOutcome = {
  /** True when we replied. The message still reaches the queue either way. */
  replied: boolean;
  /** What the message was about, for the queue and for Phase 6's analytics. */
  intent: ChatIntent | null;
};

const NOTHING: AssistantOutcome = { replied: false, intent: null };

/** "YYYY-MM-DD HH:MM" in the server's timezone, for the prompt's appointment context. */
function isoMinute(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Today in the SERVER's timezone — the same clock availability and reminders read (D-14). */
function todayIso(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * The canonical restatement, on its own line so it is easy to copy on a phone.
 * `formatWhen` guarantees the parser reads back exactly what we print here
 * (`scripts/test-parse-when-roundtrip.ts`).
 */
function echoLine(verb: "book" | "reschedule", when: Date, now: Date): string {
  return `${verb} ${formatWhen(when, now)}`;
}

/**
 * The Urdu half of the instruction. Kept beside the English so the two cannot drift,
 * and deliberately short — the line that matters is the ASCII command underneath.
 */
function urduLead(verb: "book" | "reschedule", needsWhen: boolean): string {
  const what = verb === "book" ? "اپائنٹمنٹ بک کرنے" : "اپائنٹمنٹ تبدیل کرنے";
  return needsWhen
    ? `${what} کے لیے تاریخ اور وقت اس طرح بھیجیں:`
    : `${what} کے لیے یہ پیغام بھیجیں:`;
}

/**
 * True when the message is written in a non-Latin script (Urdu, Arabic, …).
 *
 * Used ONLY to decide whether to add an Urdu line to our reply. It is a heuristic on
 * presentation, never on meaning — the classification is the model's job and does not
 * care what script the patient used.
 */
function isNonLatinScript(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return false;
  const latin = letters.filter((c) => /[A-Za-z]/.test(c)).length;
  return latin / letters.length < 0.5;
}

/**
 * An instruction plus the canonical command, bilingual when the patient wrote in
 * Urdu script.
 *
 * THE COMMAND LINE IS NEVER TRANSLATED. `parseWhen` reads ASCII — "book 5 Sep 4:00pm"
 * — and it is the patient sending that exact string back that performs the booking.
 * Translating it would produce a message our own parser rejects, which is the loop
 * `scripts/test-parse-when-roundtrip.ts` exists to prevent. So only the sentence
 * AROUND it adapts; the line they copy stays fixed.
 */
function instruct(english: string, urdu: string, command: string, nonLatin: boolean): string {
  const lead = nonLatin ? `${english}\n${urdu}` : english;
  return `${lead}\n\n${command}`;
}

async function reply(
  args: { clinicId: string; patientId: string; phone: string },
  campaignName: string,
  message: string,
): Promise<boolean> {
  const r = await sendWhatsAppToPatient({ ...args, campaignName, templateParams: [message], body: message });
  return r.ok;
}

/**
 * Classify one inbound message and, if it is actionable, reply with the canonical
 * restatement. Returns whether we replied and what the message was about.
 *
 * NEVER THROWS. Every failure — feature off, rate limited, no key, provider error,
 * unusable output, a clinical question — returns without replying, and the message
 * continues to the staff queue exactly as it does today. That is the acceptance
 * criterion for this whole feature: no worse than not having it.
 */
export async function runAssistant(args: {
  clinicId: string;
  patientId: string;
  phone: string;
  text: string;
  now?: Date;
}): Promise<AssistantOutcome> {
  const now = args.now ?? new Date();
  try {
    if (!worthClassifying(args.text)) return NOTHING;

    const clinic = await getClinic(args.clinicId);
    if (!clinicHasFeature(clinic?.featuresEnabled, "whatsapp_ai")) return NOTHING;

    // Both bounds are checked BEFORE the paid call, and a throttled message simply
    // goes to a human — never an "you are sending too many messages" reply, which
    // would be a strange thing for a clinic to say to a patient in pain.
    if (chatIntentByPhone.hit(args.phone).blocked) return NOTHING;
    if (chatIntentByClinic.hit(args.clinicId).blocked) return NOTHING;

    // The price list is only offered to the model when the clinic has opted into
    // price replies. With no list, the prompt is told the price intent is unavailable,
    // so a price question becomes `other` and reaches a person.
    // `whatsapp_prices` gates what we may SAY about money, not what we load. The
    // doctor list is also what answers a timings question — which is not price
    // disclosure — and it is what lets the model recognise a doctor by name at all,
    // so it is always fetched. Only the price and fee REPLIES are gated below.
    const quoting = clinicHasFeature(clinic?.featuresEnabled, "whatsapp_prices");
    const [procedures, doctors] = await Promise.all([
      quoting ? listQuotableProcedures(args.clinicId) : Promise.resolve([]),
      listQuotableDoctors(args.clinicId),
    ]);

    // Whether the patient already has an appointment decides whether "make the
    // appointment for Monday" means book or move. That is a FACT from the database,
    // so the model is told it rather than left to guess — the same principle as the
    // closed procedure list.
    const upcoming = await getNextUpcomingAppointment(args.clinicId, args.patientId, now);

    const c = await classifyMessage({
      text: args.text,
      today: todayIso(now),
      procedures,
      doctors,
      upcoming: upcoming ? isoMinute(upcoming.scheduledAt) : null,
      clinicId: args.clinicId,
    });
    if (!c) return NOTHING;
    const urdu = isNonLatinScript(args.text);

    // A clinical question is recognised, never answered. It reaches a human exactly
    // as `other` does — the value of naming it is that the queue can flag it, and
    // that Phase 6 can count how often it happens.
    if (c.intent === "clinical" || c.intent === "other") {
      return { replied: false, intent: c.intent };
    }

    if (c.intent === "price" && c.procedureId) {
      if (!quoting) return { replied: false, intent: "price" };
      const proc = procedures.find((p) => p.id === c.procedureId);
      // `parseClassification` already rejected an id we did not offer, so this can
      // only be null if the list changed underneath us. Say nothing rather than guess.
      if (!proc) return { replied: false, intent: "other" };
      const replied = await reply(
        args,
        serverEnv.AISENSY_BOOKING_REPLY_CAMPAIGN,
        priceMessage(proc.name, proc.price),
      );
      return { replied, intent: "price" };
    }

    if (c.intent === "location") {
      const message = locationMessage(clinic?.publicAddress ?? null, clinic?.openingHours ?? null);
      // Nothing set: the clinic has not told us where it is, so a person answers.
      if (!message) return { replied: false, intent: "location" };
      const replied = await reply(args, serverEnv.AISENSY_BOOKING_REPLY_CAMPAIGN, message);
      return { replied, intent: "location" };
    }

    if (c.intent === "hours") {
      const message = hoursMessage(doctors, clinic?.openingHours ?? null);
      if (!message) return { replied: false, intent: "other" };
      const replied = await reply(args, serverEnv.AISENSY_BOOKING_REPLY_CAMPAIGN, message);
      return { replied, intent: "hours" };
    }

    // "How much do you charge?" — nobody named. The classifier keeps this as `fee`
    // with an empty list (a doctor we do NOT have becomes `other` instead), so this
    // is a general question we can answer in full rather than decline.
    if (c.intent === "fee" && c.doctorIds.length === 0) {
      if (!quoting) return { replied: false, intent: "fee" };
      const message = allFeesMessage(doctors);
      if (!message) return { replied: false, intent: "other" };
      const replied = await reply(args, serverEnv.AISENSY_BOOKING_REPLY_CAMPAIGN, message);
      return { replied, intent: "fee" };
    }

    if (c.intent === "fee" && c.doctorIds.length > 0) {
      if (!quoting) return { replied: false, intent: "fee" };
      const named = c.doctorIds
        .map((id) => doctors.find((d) => d.id === id))
        .filter((d): d is QuotableDoctor => Boolean(d));
      const message = feeMessage(named);
      // No fee set for anyone they named — a person answers rather than a guess.
      if (!message) return { replied: false, intent: "other" };
      const replied = await reply(args, serverEnv.AISENSY_BOOKING_REPLY_CAMPAIGN, message);
      return { replied, intent: "fee" };
    }

    if (c.intent === "cancel") {
      // No date to restate — the deterministic handler cancels the patient's next
      // upcoming appointment, so the canonical form is the bare word.
      if (!clinicHasFeature(clinic?.featuresEnabled, "whatsapp_cancel")) {
        return { replied: false, intent: "cancel" };
      }
      const replied = await reply(
        args,
        serverEnv.AISENSY_RESCHEDULE_CAMPAIGN,
        instruct(
          "To cancel your appointment, reply with this message:",
          "اپائنٹمنٹ منسوخ کرنے کے لیے یہ پیغام بھیجیں:",
          "cancel appointment",
          urdu,
        ),
      );
      return { replied, intent: "cancel" };
    }

    const verb = c.intent === "book" ? "book" : "reschedule";
    const campaign =
      verb === "book" ? serverEnv.AISENSY_BOOKING_REPLY_CAMPAIGN : serverEnv.AISENSY_RESCHEDULE_CAMPAIGN;
    const what = verb === "book" ? "book" : "move your appointment";

    // Only restate a time the patient actually gave. Filling in a plausible one would
    // put a time in their mouth that they might send straight back.
    if (c.date && c.time) {
      const when = new Date(c.date.y, c.date.m - 1, c.date.d, c.time.h, c.time.min, 0, 0);
      if (when.getTime() <= now.getTime()) return { replied: false, intent: c.intent };
      const replied = await reply(
        args,
        campaign,
        instruct(
          `To ${what}, reply with this message:`,
          urduLead(verb, false),
          echoLine(verb, when, now),
          urdu,
        ),
      );
      return { replied, intent: c.intent };
    }

    // Intent understood, date or time missing. Today this message gets no reply at
    // all, so a worked EXAMPLE is strictly better — and it teaches the format, which
    // is what keeps the next message off this path entirely.
    const example = new Date(now);
    example.setDate(example.getDate() + 1);
    example.setHours(16, 0, 0, 0);
    const replied = await reply(
      args,
      campaign,
      instruct(
        `To ${what}, reply with the date and time, like this:`,
        urduLead(verb, true),
        echoLine(verb, example, now),
        urdu,
      ),
    );
    return { replied, intent: c.intent };
  } catch (e) {
    // The message still reaches the front desk; that is the whole fallback.
    report(e, { op: "whatsapp.assistant", clinicId: args.clinicId });
    return NOTHING;
  }
}

/**
 * "What are your timings?" — and this is the message the whole opening-hours design
 * rests on.
 *
 * It states TWO different true things, in this order: when the clinic is OPEN (what
 * the clinic admin typed) and when DOCTORS SEE PATIENTS (their working hours). They
 * are not the same, and a patient told only the first will turn up when nobody can
 * see them. Printing both is what makes a free-text opening-hours field safe to have:
 * it can never contradict bookability, because the thing that governs bookability is
 * printed right underneath it.
 *
 * Either half may be missing. A clinic that has typed nothing still gets a useful
 * answer from its doctors; a clinic whose doctors have no hours set still gets to say
 * when it is open. Only when BOTH are empty is there no reply.
 */
function hoursMessage(
  doctors: readonly QuotableDoctor[],
  openingHours: ClinicHour[] | null,
): string | null {
  // A doctor with neither set hours nor flexible hours tells the patient nothing, so
  // they are left out rather than listed under a heading that promises times.
  const withHours = doctors.filter((d) => d.hours || d.flexible);
  const open = describeClinicHours(openingHours ?? []);
  if (!open && withHours.length === 0) return null;

  const parts: string[] = [];
  if (open) parts.push(`We're open:\n${open}`);
  if (withHours.length > 0) {
    const perDoctor = withHours
      .map((d) => `${d.name}\n  ${d.hours || "By appointment"}`)
      .join("\n\n");
    parts.push(`When our doctors see patients:\n\n${perDoctor}`);
  }
  return `${parts.join("\n\n")}\n\nTo book, reply with the date and time, like this:\n\nbook 12 Jul 4:00pm`;
}

/**
 * "Where are you?" — the clinic's own words, or nothing.
 *
 * There is no fallback to `clinics.address`: that is the super-admin CRM field used as
 * the bill-to line on FlexicaAI's subscription invoices, and a group's billing may go
 * to a head office while the patient needs the branch. Sending a patient to a billing
 * address because it was the only one we had is a worse failure than saying nothing
 * and letting the front desk answer.
 */
function locationMessage(publicAddress: string | null, openingHours: ClinicHour[] | null): string | null {
  const address = publicAddress?.trim();
  if (!address) return null;
  const open = describeClinicHours(openingHours ?? []);
  return (
    `We're at:\n${address}` +
    (open ? `\n\nOpen: ${open}` : "") +
    `\n\nTo book, reply with the date and time, like this:\n\nbook 12 Jul 4:00pm`
  );
}

/**
 * The answer to "how much do you charge?" — a question that names nobody.
 *
 * Declining this was the wrong call. The patient asked something perfectly reasonable,
 * we know the answer for every doctor, and the reason we could not reply was an
 * implementation detail (no id to key on). Listing the clinic's doctors with their
 * fee AND their consultation hours answers the question and gives them what they need
 * next, which is when they can actually be seen.
 *
 * Doctors with no fee set are omitted here rather than named. That differs from
 * `feeMessage` on purpose: there the patient asked about a SPECIFIC doctor and
 * silence about them would look like the question was half heard, whereas here nobody
 * was named, so an unpriced doctor is simply not part of the answer. If none are
 * priced there is no reply at all.
 */
function allFeesMessage(doctors: readonly QuotableDoctor[]): string | null {
  const priced = doctors.filter((d) => d.fee > 0);
  if (priced.length === 0) return null;

  const rs = (n: number) => new Intl.NumberFormat("en-PK").format(n);
  const lines = priced
    .map((d) => `${d.name} — Rs ${rs(d.fee)}${d.hours ? `\n  ${d.hours}` : ""}`)
    .join("\n\n");
  const which =
    priced.length > 1
      ? "\n\nReply with the doctor you'd like to see, or the date and time, like this:"
      : "\n\nTo book, reply with the date and time, like this:";
  return (
    `Our consultation fees:\n\n${lines}\n\n` +
    `This is the consultation only — any treatment on the day is charged separately.` +
    `${which}\n\nbook 12 Jul 4:00pm`
  );
}

/**
 * The consultation-fee sentence, for one or more doctors the patient named.
 *
 * A FEE IS NOT A PRICE, and the wording keeps them apart. `charge_consultation` is
 * per appointment, so a procedure-only visit is not billed this at all — hence
 * "consultation fee", never "what you will pay".
 *
 * `consultation_fee` defaults to 0, which means NOT SET, never free. Quoting "Rs 0"
 * would be actively wrong, so those doctors are named and handed to the clinic rather
 * than dropped: a patient who asked about two doctors and got one answered would
 * reasonably think the other had been missed.
 */
function feeMessage(named: readonly QuotableDoctor[]): string | null {
  const priced = named.filter((d) => d.fee > 0);
  const unpriced = named.filter((d) => d.fee <= 0);
  // Nothing quotable at all — say nothing and let a person answer.
  if (priced.length === 0) return null;

  const rs = (n: number) => new Intl.NumberFormat("en-PK").format(n);
  const lines = priced.map((d) => `${d.name}: Rs ${rs(d.fee)}`).join("\n");
  const missing = unpriced.length
    ? `\n\nFor ${unpriced.map((d) => d.name).join(" and ")}, please ask the clinic.`
    : "";
  return (
    `Consultation fee${priced.length > 1 ? "s" : ""}:\n${lines}${missing}\n\n` +
    `This is the consultation only — any treatment on the day is charged separately.\n\n` +
    `To book, reply with the date and time, like this:\n\nbook 12 Jul 4:00pm`
  );
}

/**
 * The price sentence. Three constraints, none optional:
 *  - INDICATIVE, because a texted price is a commitment patients will hold you to;
 *  - it EXCLUDES the consultation fee, which lives on `users.consultation_fee` and is
 *    per DOCTOR — so a total genuinely cannot be quoted from a procedure row;
 *  - it says the final amount is confirmed at the visit.
 * It ends with the booking line, so a price question can become a booking.
 */
function priceMessage(name: string, price: number): string {
  const rs = new Intl.NumberFormat("en-PK").format(price);
  return (
    `${name}: from Rs ${rs} — indicative, and excludes consultation and anything ` +
    `else needed on the day. The final amount is confirmed at your visit.\n\n` +
    `To book, reply with the date and time, like this:\n\nbook 12 Jul 4:00pm`
  );
}
