"use client";

import { useActionState, useEffect, useState } from "react";
import { Check, Minus, Plus, Search } from "lucide-react";
import { cn } from "@/core/lib/utils";
import {
  createAppointment,
  doctorDayAvailability,
  searchClinicPatients,
  updateAppointment,
  type DoctorDaySlots,
  type ReceptionActionState,
} from "@/app/clinic/appointments/actions";
import { Button } from "@/core/ui/button";
import { DatePicker } from "@/core/ui/date-picker";
import { Input } from "@/core/ui/input";
import { Label } from "@/core/ui/label";
import { TimeSelect } from "@/core/ui/time-select";
import { Toast } from "@/core/ui/toast";
import { SearchableSelect } from "@/core/ui/searchable-select";
import { syncChecked } from "@/core/ui/checkbox-sync";
import {
  MAX_DISCOUNT_PERCENT,
  computeBill,
  formatPkr,
  type DiscountType,
} from "@/core/appointments/fee";

type Patient = { id: string; fullName: string; phone: string | null; mrn?: string | null };
type Doctor = {
  id: string;
  fullName: string | null;
  username: string;
  flexibleHours: boolean;
  consultationFee: number;
};
type ProcedureOption = { id: string; name: string; price: number };

const pad = (n: number) => String(n).padStart(2, "0");
const timeToMin = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
/** "09:30" → "9:30 AM" */
const label12 = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const mer = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${mer}`;
};

// Native <select> variant: themed chevron with a comfortable gap from the right
// edge (see `.select-chevron` in globals.css).
const nativeSelectCls =
  "h-8 w-full rounded-lg border border-input bg-[var(--input-bg)] pl-2.5 pr-8 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 select-chevron";

/**
 * Appointment form — create OR edit. The time picker ADAPTS to the doctor: a
 * doctor with set visiting hours shows radio buttons of the day's window(s); a
 * flexible / "Any" doctor shows a free time picker.
 *
 * Edit mode (pass `appointmentId` + `fixedPatient` + `initial`): the patient is
 * fixed, the fields are prefilled, and it saves via updateAppointment.
 */
export function NewAppointmentForm({
  initialPatients,
  doctors,
  procedures = [],
  appointmentId,
  fixedPatient,
  preselectedPatient,
  preselectedDate,
  planItems = [],
  initial,
}: {
  initialPatients: Patient[];
  doctors: Doctor[];
  /** The clinic's active procedures (empty unless the `sales` feature is on). */
  procedures?: ProcedureOption[];
  /** Unscheduled treatment-plan items for the (preselected) patient — booking-from-plan. */
  planItems?: { id: string; name: string; tooth: string | null; unitPrice: number; quantity: number; planTitle: string }[];
  appointmentId?: string;
  fixedPatient?: { id: string; fullName: string };
  /** Create mode: start with this patient chosen (from "Book" on a patient row),
   *  still changeable. */
  preselectedPatient?: Patient | null;
  /** Create mode: start on this date (the day the appointments list was showing),
   *  still changeable. Ignored in edit mode, where  is the real one. */
  preselectedDate?: string;
  initial?: {
    doctorId: string;
    date: string;
    time: string;
    reason: string;
    durationMinutes: number;
    discountType: DiscountType;
    discountValue: number;
    discountBorneBy?: string;
    discountSplitType?: string;
    discountSplitValue?: number;
    chargeConsultation?: boolean;
    customTime?: boolean;
    procedures?: {
      procedureId: string;
      quantity: number;
      discountType?: DiscountType;
      discountValue?: number;
    }[];
  };
}) {
  const isEdit = Boolean(appointmentId);
  const [patient, setPatient] = useState<Patient | null>(preselectedPatient ?? null);
  const [planItemSel, setPlanItemSel] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Patient[]>(initialPatients);
  const [doctorId, setDoctorId] = useState(initial?.doctorId ?? "");
  // `initial.date` wins over the prefill: in edit mode it IS the appointment's own
  // date, and a stray `?date=` must never silently move a booking that exists.
  const [date, setDate] = useState(initial?.date ?? preselectedDate ?? "");
  const [time, setTime] = useState(initial?.time ?? "09:00");
  const [duration, setDuration] = useState(initial?.durationMinutes ?? 30);
  const [reason, setReason] = useState(initial?.reason ?? "");
  const [discountType, setDiscountType] = useState<DiscountType>(
    initial?.discountType ?? "amount",
  );
  // Kept as a string so the field can be emptied while typing (a numeric state
  // would snap a cleared field back to 0). Parsed to a number where needed; a
  // blank/invalid value is treated as 0 (no discount).
  const [discountValue, setDiscountValue] = useState(
    initial?.discountValue ? String(initial.discountValue) : "",
  );
  const discountNumber = Math.max(0, Number(discountValue) || 0);
  // Who absorbs the discount: the clinic, the appointment's doctor, or split between
  // them (only matters once a discount is entered).
  const [borneBy, setBorneBy] = useState<"clinic" | "doctor" | "split">(
    initial?.discountBorneBy === "doctor" || initial?.discountBorneBy === "split"
      ? initial.discountBorneBy
      : "clinic",
  );
  // For borne-by = "split": how much of the discount the DOCTOR side bears.
  const [splitType, setSplitType] = useState<DiscountType>(
    initial?.discountSplitType === "amount" ? "amount" : "percent",
  );
  const [splitValue, setSplitValue] = useState(
    initial?.discountSplitValue ? String(initial.discountSplitValue) : "",
  );
  const splitNumber = Math.max(0, Number(splitValue) || 0);
  // A procedure-only visit can skip the doctor's consultation fee.
  const [chargeConsultation, setChargeConsultation] = useState(
    initial?.chargeConsultation ?? true,
  );
  const [customTime, setCustomTime] = useState(initial?.customTime ?? false);
  // Selected procedures → { quantity (≥1) }. There is NO per-procedure discount —
  // the only discount is the appointment-level one below. Missing key = unselected.
  type ProcState = { quantity: number };
  const [procSel, setProcSel] = useState<Map<string, ProcState>>(() => {
    const m = new Map<string, ProcState>();
    for (const it of initial?.procedures ?? []) {
      m.set(it.procedureId, { quantity: Math.max(1, it.quantity) });
    }
    return m;
  });
  const toggleProc = (id: string) =>
    setProcSel((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, { quantity: 1 });
      return next;
    });
  const setQty = (id: string, q: number) =>
    setProcSel((prev) => {
      if (q <= 0) {
        const next = new Map(prev);
        next.delete(id);
        return next;
      }
      const cur = prev.get(id);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(id, { quantity: Math.min(99, q) });
      return next;
    });
  // A procedure line's total is simply its price × quantity (no per-line discount).
  const procLine = (p: ProcedureOption) => {
    const s = procSel.get(p.id);
    if (!s) return null;
    return { gross: p.price * s.quantity, net: p.price * s.quantity };
  };
  // The selected lines, in the shape the shared bill takes. This form has no
  // per-line discount (see the hidden field below), so each line's gross IS its net
  // — but going through `computeBill` rather than a local sum means the preview uses
  // the same formula as the invoice it will become, and gains line discounts for
  // free if this form ever offers them.
  const billLines = procedures
    .filter((p) => procSel.has(p.id))
    .map((p) => ({
      unitPrice: p.price,
      quantity: procSel.get(p.id)!.quantity,
      discountType: "amount" as DiscountType,
      discountValue: 0,
    }));
  const [slots, setSlots] = useState<DoctorDaySlots | null>(null);
  const action = isEdit
    ? updateAppointment.bind(null, appointmentId!)
    : createAppointment;
  const [state, formAction, pending] = useActionState<
    ReceptionActionState,
    FormData
  >(action, {});

  // Re-trigger the error toast on every failed submit — `state` is a fresh
  // object each time the action settles, so this bumps even for an identical
  // error message on a second attempt.
  const [errorNonce, setErrorNonce] = useState(0);
  const [savedNonce, setSavedNonce] = useState(0);
  useEffect(() => {
    if (state.error) setErrorNonce((n) => n + 1);
    else if (state.saved) setSavedNonce((n) => n + 1);
  }, [state]);

  async function runSearch(q: string) {
    setQuery(q);
    setResults(await searchClinicPatients(q));
  }

  // Fetch the doctor's availability/windows for the chosen date (local noon so
  // the weekday is right). Only meaningful once a specific doctor + date are set.
  async function refreshSlots(dId: string, d: string) {
    if (!dId || !d) {
      setSlots(null);
      return;
    }
    setSlots(await doctorDayAvailability(dId, `${d}T12:00`));
  }

  // On mount (edit prefill), load the doctor's windows for the initial date.
  useEffect(() => {
    if (doctorId && date) void refreshSlots(doctorId, date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedDoctor = doctors.find((d) => d.id === doctorId) ?? null;
  const doctorOptions = [
    { value: "", label: "— Any —" },
    ...doctors.map((d) => ({ value: d.id, label: d.fullName ?? d.username })),
  ];
  const consultationFee = selectedDoctor?.consultationFee ?? 0;
  // Live bill preview: consultation fee (if charged) + procedures, minus discount.
  const bill = computeBill(
    chargeConsultation ? consultationFee : 0,
    billLines,
    discountType,
    discountNumber,
  );
  // A custom time frees the picker exactly as a flexible doctor does — the server
  // applies the same relaxation (checkDoctorSlot's `customTime`), so the form can
  // never offer a time the action would then refuse.
  const freeTime = !doctorId || Boolean(selectedDoctor?.flexibleHours) || customTime;
  const onLeaveBlock = Boolean(doctorId) && Boolean(date) && Boolean(slots?.onLeave);

  // Whether this visit carries procedures decides which windows the SERVER will
  // accept (checkDoctorSlot widens to procedure windows only then), so the form
  // offers exactly that set — never more, never less. Note it's the procedures,
  // not the consultation-fee checkbox: a visit can skip the fee and still be a
  // plain consultation, which a procedure window would refuse.
  const hasProcedures = procSel.size > 0;

  // With the override ON, is the chosen time inside the doctor's hours ANYWAY? The
  // server asks exactly this (checkDoctorSlot's `withinHours`) and drops the flag when
  // it is true, so without saying so here the form silently disagrees with what gets
  // saved: staff tick "Custom time", pick a time that turns out to be in hours, and
  // then wonder why the visit appears on the normal queue card instead of its own.
  const customTimeUnnecessary =
    customTime &&
    Boolean(doctorId) &&
    !selectedDoctor?.flexibleHours &&
    Boolean(time) &&
    slots !== null &&
    !slots.onLeave &&
    slots.available &&
    slots.windows
      .filter((w) => hasProcedures || w.kind !== "procedure")
      .some((w) => timeToMin(time) >= timeToMin(w.start) && timeToMin(time) < timeToMin(w.end));

  const constrained =
    !freeTime &&
    Boolean(date) &&
    slots !== null &&
    !slots.onLeave &&
    slots.available &&
    slots.windows.length > 0;
  const windows = constrained
    ? slots!.windows.filter((w) => hasProcedures || w.kind !== "procedure")
    : [];
  // The selected window is whichever one contains the current time.
  const selectedWindowIdx = windows.findIndex(
    (w) => timeToMin(time) >= timeToMin(w.start) && timeToMin(time) < timeToMin(w.end),
  );

  // Keep `time` inside a BOOKABLE window (snap to the first if it isn't) — after
  // switching doctor or date, and after removing the last procedure, which can
  // strand the time inside a procedure window that no longer applies.
  useEffect(() => {
    if (freeTime || !slots) return;
    const ws = slots.windows.filter((w) => hasProcedures || w.kind !== "procedure");
    if (ws.length === 0) return;
    const inWindow = ws.some(
      (w) => timeToMin(time) >= timeToMin(w.start) && timeToMin(time) < timeToMin(w.end),
    );
    if (!inWindow) setTime(ws[0].start);
  }, [slots, freeTime, time, hasProcedures]);

  const effectiveTime = freeTime ? time : selectedWindowIdx >= 0 ? time : "";
  const scheduledAt =
    !onLeaveBlock && date && effectiveTime ? `${date}T${effectiveTime}` : "";

  return (
    <form action={formAction} className="space-y-4">
      <input
        type="hidden"
        name="patientId"
        value={isEdit ? (fixedPatient?.id ?? "") : (patient?.id ?? "")}
      />
      <input type="hidden" name="scheduledAt" value={scheduledAt} />
      <input type="hidden" name="customTime" value={customTime ? "1" : "0"} />

      <div className="space-y-2">
        <Label>Patient</Label>
        {isEdit ? (
          <div className="text-sm font-medium">{fixedPatient?.fullName}</div>
        ) : patient ? (
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-accent px-2.5 py-1 text-sm font-medium text-accent-foreground">
              {patient.fullName}
            </span>
            <button
              type="button"
              className="text-sm text-muted-foreground underline underline-offset-4"
              onClick={() => setPatient(null)}
            >
              Change
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Search patients by name or phone…"
                value={query}
                onChange={(e) => void runSearch(e.target.value)}
                aria-label="Search patients"
              />
            </div>
            <ul className="max-h-48 divide-y overflow-y-auto rounded-md border">
              {results.length === 0 ? (
                <li className="p-3 text-sm text-muted-foreground">
                  No patients found.
                </li>
              ) : (
                results.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setPatient(p)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
                    >
                      <span className="min-w-0">
                        <span className="font-medium">{p.fullName}</span>
                        {p.mrn ? (
                          <span className="ml-2 text-xs tabular-nums text-muted-foreground">{p.mrn}</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-muted-foreground">{p.phone ?? ""}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Doctor (optional)</Label>
          <SearchableSelect
            ariaLabel="Doctor"
            name="doctorId"
            value={doctorId}
            onChange={(v) => {
              setDoctorId(v);
              void refreshSlots(v, date);
            }}
            options={doctorOptions}
            placeholder="Any doctor"
            className="w-full"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="durationMinutes">Duration (minutes)</Label>
          <Input
            id="durationMinutes"
            name="durationMinutes"
            type="number"
            min={5}
            max={480}
            step={5}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="date">Date</Label>
          <DatePicker
            id="date"
            ariaLabel="Appointment date"
            value={date}
            onChange={(v) => {
              setDate(v);
              void refreshSlots(doctorId, v);
            }}
          />
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label>{freeTime ? "Time" : "Available times"}</Label>
            {/* Only offered when hours actually constrain the choice: a flexible
                doctor (or "Any doctor") is already free, so the toggle would claim
                to do something it isn't doing. */}
            {doctorId && !selectedDoctor?.flexibleHours ? (
              <label className="flex min-h-6 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-3.5 accent-[var(--primary)]"
                  checked={customTime}
                  ref={syncChecked(customTime)}
                  onChange={(e) => setCustomTime(e.target.checked)}
                />
                Custom time (outside visiting hours)
              </label>
            ) : null}
          </div>
          {onLeaveBlock ? (
            <p className="text-sm text-destructive">
              Doctor is on leave that day. Pick another date.
            </p>
          ) : freeTime ? (
            <>
              <TimeSelect
                ariaLabel="Appointment time"
                value={effectiveTime || "09:00"}
                onChange={setTime}
              />
              {customTimeUnnecessary ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  This time is within the doctor&apos;s visiting hours, so no exception
                  is needed — it will be saved as a normal appointment.
                </p>
              ) : null}
            </>
          ) : !date ? (
            <p className="text-sm text-muted-foreground">
              Pick a date to see the doctor&apos;s available times.
            </p>
          ) : slots === null ? (
            <p className="text-sm text-muted-foreground">Loading times…</p>
          ) : !slots.available ? (
            <p className="text-sm text-destructive">
              Doctor doesn&apos;t work that day. Pick another date, or tick{" "}
              <strong>Custom time</strong> above to book anyway.
            </p>
          ) : windows.length === 0 ? (
            // Distinguish "doesn't work" from "works, but only on procedures" —
            // the second is fixed by adding a procedure, not by changing the date.
            <p className="text-sm text-destructive">
              {slots.windows.length > 0
                ? "That day is procedure-only. Add a procedure below, or pick another date."
                : "No available times that day."}{" "}
              You can also tick <strong>Custom time</strong> above to book outside the
              doctor&apos;s hours.
            </p>
          ) : (
            // Specific-hours doctor → pick one of the visiting-hours window(s).
            // These are buttons (not <input type="radio">) on purpose: React 19
            // auto-resets the <form> after a successful save, and native
            // form.reset() would clear a real radio and make the selection flash.
            // As React-state-only controls they're immune to the reset; the value
            // is submitted via the hidden `scheduledAt`.
            <div role="radiogroup" aria-label="Available times" className="space-y-1.5">
              {windows.map((w, i) => {
                const checked = selectedWindowIdx === i;
                return (
                  <button
                    key={i}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    onClick={() => setTime(w.start)}
                    className="flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                  >
                    <span
                      className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${
                        checked ? "border-primary" : "border-input"
                      }`}
                    >
                      {checked ? (
                        <span className="size-2 rounded-full bg-primary" />
                      ) : null}
                    </span>
                    <span>
                      {label12(w.start)} – {label12(w.end)}
                    </span>
                    {/* This slot is only in the list because procedures were
                        added — say so, since it appears and disappears. */}
                    {w.kind === "procedure" ? (
                      <span className="ml-auto rounded-md border border-input px-1.5 py-0.5 text-xs text-muted-foreground">
                        Procedure slot
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="reason">Reason (optional)</Label>
          <Input
            id="reason"
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Cleaning"
          />
        </div>

        {/* Consultation fee — its OWN section, separate from procedures. It comes
            from the doctor's set fee (staff → doctor), so it appears the moment a
            doctor is selected. Uncheck to skip it for a procedure-only visit. The
            hidden field always submits the decision (unchecked boxes don't post). */}
        <input
          type="hidden"
          name="chargeConsultation"
          value={chargeConsultation ? "1" : "0"}
        />
        {selectedDoctor ? (
          <div className="space-y-2 rounded-lg border p-3 sm:col-span-2">
            <div className="flex items-center justify-between gap-3">
              <Label className="font-medium">Consultation fee</Label>
              <span className="text-sm font-semibold">
                {consultationFee > 0 ? formatPkr(consultationFee) : "Not set"}
              </span>
            </div>
            {consultationFee > 0 ? (
              <>
                <label className="flex min-h-6 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={chargeConsultation}
                    ref={syncChecked(chargeConsultation)}
                    onChange={(e) => setChargeConsultation(e.target.checked)}
                    className="size-4 accent-[var(--color-primary)]"
                  />
                  Charge this consultation fee
                </label>
                <p className="text-xs text-muted-foreground">
                  Uncheck if the patient is coming only for a procedure.
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                This doctor has no consultation fee set. Add it under Staff.
              </p>
            )}
          </div>
        ) : null}

        {/* Procedures the patient is booked for — priced line items that add to
            the appointment total. Only shown when the clinic has procedures. */}
        {!isEdit && planItems.length > 0 ? (
          <div className="space-y-2 sm:col-span-2 rounded-lg border border-primary/40 bg-accent/30 p-3">
            <Label>From treatment plan</Label>
            <p className="text-xs text-muted-foreground">
              Tick items to schedule onto this visit. They bill like procedures.
            </p>
            {[...planItemSel].map((id) => (
              <input key={id} type="hidden" name="planItemId" value={id} />
            ))}
            <div className="space-y-1">
              {planItems.map((it) => {
                const checked = planItemSel.has(it.id);
                return (
                  <label key={it.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      ref={syncChecked(checked)}
                      onChange={() =>
                        setPlanItemSel((prev) => {
                          const next = new Set(prev);
                          if (next.has(it.id)) next.delete(it.id);
                          else next.add(it.id);
                          return next;
                        })
                      }
                      className="size-4 accent-[var(--color-primary)]"
                    />
                    <span>
                      {it.name}
                      {it.tooth ? <span className="text-muted-foreground"> · {it.tooth}</span> : null}
                      <span className="text-muted-foreground"> · {it.planTitle}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        {procedures.length > 0 ? (
          <div className="space-y-2 sm:col-span-2">
            <Label>Procedures (optional)</Label>
            <div className="flex flex-wrap gap-2">
              {procedures.map((p) => {
                const checked = procSel.has(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={checked}
                    onClick={() => toggleProc(p.id)}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors",
                      checked ? "border-primary bg-primary/10" : "hover:bg-accent",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex size-4 shrink-0 items-center justify-center rounded border",
                        checked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input",
                      )}
                    >
                      {checked ? <Check className="size-3" aria-hidden="true" /> : null}
                    </span>
                    {p.name} · {formatPkr(p.price)}
                  </button>
                );
              })}
            </div>

            {/* Per-procedure quantity + the line total (no per-line discount — the
                discount is applied once to the whole appointment below). */}
            {procSel.size > 0 ? (
              <ul className="divide-y rounded-lg border">
                {procedures
                  .filter((p) => procSel.has(p.id))
                  .map((p) => {
                    const s = procSel.get(p.id)!;
                    const line = procLine(p)!;
                    return (
                      <li
                        key={p.id}
                        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2 text-sm"
                      >
                        <span className="min-w-0 truncate font-medium">
                          {p.name}
                          <span className="font-normal text-muted-foreground">
                            {" "}
                            · {formatPkr(p.price)}
                          </span>
                        </span>
                        <div className="flex flex-wrap items-center gap-3">
                          {/* quantity */}
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              aria-label={`Decrease ${p.name} quantity`}
                              onClick={() => setQty(p.id, s.quantity - 1)}
                              className="inline-flex size-7 items-center justify-center rounded-md border hover:bg-accent"
                            >
                              <Minus className="size-3.5" aria-hidden="true" />
                            </button>
                            <span className="w-6 text-center tabular-nums" aria-live="polite">
                              {s.quantity}
                            </span>
                            <button
                              type="button"
                              aria-label={`Increase ${p.name} quantity`}
                              onClick={() => setQty(p.id, s.quantity + 1)}
                              className="inline-flex size-7 items-center justify-center rounded-md border hover:bg-accent"
                            >
                              <Plus className="size-3.5" aria-hidden="true" />
                            </button>
                          </div>
                          <span className="w-24 text-right font-medium tabular-nums">
                            {formatPkr(line.net)}
                          </span>
                        </div>
                      </li>
                    );
                  })}
              </ul>
            ) : null}

            {/* One hidden field per procedure: "<id>:<qty>". No per-line discount;
                the performing doctor is the appointment's doctor (set server-side). */}
            {[...procSel.entries()].map(([id, s]) => (
              <input
                key={id}
                type="hidden"
                name="procedure"
                value={`${id}:${s.quantity}`}
              />
            ))}
          </div>
        ) : null}

        {/* Discount off the whole bill (consultation fee + procedures). Default
            type is Amount (flat PKR); switch to Percent for a % of the total. */}
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="discountValue">Discount (optional)</Label>
          <div className="flex gap-2">
            <select
              id="discountType"
              name="discountType"
              value={discountType}
              onChange={(e) => setDiscountType(e.target.value as DiscountType)}
              className={`${nativeSelectCls} w-auto`}
              aria-label="Discount type"
            >
              <option value="amount">Amount (Rs)</option>
              <option value="percent">Percent (%)</option>
            </select>
            <Input
              id="discountValue"
              name="discountValue"
              type="number"
              inputMode="numeric"
              min={0}
              max={discountType === "percent" ? MAX_DISCOUNT_PERCENT : undefined}
              step={discountType === "percent" ? 1 : 50}
              value={discountValue}
              onChange={(e) => {
                // Digits only; allow empty so the field can be cleared. A percentage
                // is also CLAMPED here: `max` on a number input only constrains the
                // spinner, so 99999 could still be typed — and that value used to
                // reach the database and overflow the SQL bill (ADR-021). Clamping in
                // the field beats a server error after the form is filled in.
                const v = e.target.value.replace(/[^\d]/g, "");
                setDiscountValue(
                  discountType === "percent" && v !== ""
                    ? String(Math.min(Number(v), MAX_DISCOUNT_PERCENT))
                    : v,
                );
              }}
              placeholder={discountType === "percent" ? "e.g. 20" : "e.g. 500"}
            />
          </div>
          {bill.gross > 0 ? (
            (() => {
              const parts: string[] = [];
              if (bill.consultation > 0) parts.push(`${formatPkr(bill.consultation)} fee`);
              if (bill.proceduresNet > 0) parts.push(`${formatPkr(bill.proceduresNet)} procedures`);
              const lhs =
                parts.length > 1 ? `${parts.join(" + ")} = ${formatPkr(bill.gross)}` : parts[0];
              return (
                <p className="text-sm text-muted-foreground">
                  {lhs}
                  {bill.discount > 0 ? ` − ${formatPkr(bill.discount)} discount` : ""} ={" "}
                  <span className="font-medium text-foreground">{formatPkr(bill.net)}</span>
                </p>
              );
            })()
          ) : selectedDoctor ? (
            <p className="text-sm text-muted-foreground">
              {consultationFee > 0
                ? "Consultation fee not charged and no procedures selected."
                : "No consultation fee set and no procedures selected."}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Pick a doctor or procedures to see the total.
            </p>
          )}

          {/* Who absorbs the discount in the doctor/clinic revenue split. Only
              relevant once a discount is entered. Submitted always so an edit that
              clears the discount still records a sane value. */}
          <input type="hidden" name="discountBorneBy" value={borneBy} />
          <input type="hidden" name="discountSplitType" value={splitType} />
          <input type="hidden" name="discountSplitValue" value={borneBy === "split" ? String(splitNumber) : "0"} />
          {discountNumber > 0 ? (
            <div className="space-y-1.5 pt-1">
              <Label className="text-xs text-muted-foreground">Discount borne by</Label>
              <div role="radiogroup" aria-label="Discount borne by" className="flex flex-wrap gap-2">
                {(
                  [
                    ["clinic", "Clinic"],
                    ["doctor", "Doctor"],
                    ["split", "Split"],
                  ] as const
                ).map(([val, label]) => {
                  const checked = borneBy === val;
                  return (
                    <button
                      key={val}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      onClick={() => setBorneBy(val)}
                      className={cn(
                        "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                        checked ? "border-primary bg-primary/10" : "hover:bg-accent",
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Whether the clinic absorbs the discount, it comes off the doctor&apos;s
                share, or it&apos;s split between them. If the bearer requires it, the
                discount waits for approval before it applies.
              </p>

              {/* Split → how much the DOCTOR side bears, with a live preview. */}
              {borneBy === "split" ? (
                (() => {
                  const doctorBorne =
                    splitType === "amount"
                      ? Math.min(splitNumber, bill.discount)
                      : Math.round((bill.discount * splitNumber) / 100);
                  const clinicBorne = Math.max(0, bill.discount - doctorBorne);
                  return (
                    <div className="space-y-1.5 rounded-lg border border-dashed p-2.5">
                      <Label className="text-xs text-muted-foreground">Doctor bears</Label>
                      <div className="flex gap-2">
                        <select
                          value={splitType}
                          onChange={(e) => setSplitType(e.target.value as DiscountType)}
                          className={`${nativeSelectCls} w-auto`}
                          aria-label="Doctor's share type"
                        >
                          <option value="percent">Percent (%)</option>
                          <option value="amount">Amount (Rs)</option>
                        </select>
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={splitType === "percent" ? MAX_DISCOUNT_PERCENT : bill.discount || undefined}
                          step={splitType === "percent" ? 5 : 50}
                          value={splitValue}
                          onChange={(e) => {
                            // Same clamp as the discount field above.
                            const v = e.target.value.replace(/[^\d]/g, "");
                            setSplitValue(
                              splitType === "percent" && v !== ""
                                ? String(Math.min(Number(v), MAX_DISCOUNT_PERCENT))
                                : v,
                            );
                          }}
                          placeholder={splitType === "percent" ? "e.g. 50" : "e.g. 250"}
                          aria-label="Doctor's share of the discount"
                        />
                      </div>
                      {bill.discount > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Of the {formatPkr(bill.discount)} discount: clinic bears{" "}
                          <span className="font-medium text-foreground">{formatPkr(clinicBorne)}</span>, doctor bears{" "}
                          <span className="font-medium text-foreground">{formatPkr(doctorBorne)}</span>.
                        </p>
                      ) : null}
                    </div>
                  );
                })()
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* Doctor's hours + remaining capacity for the chosen day. */}
      {slots && slots.available ? (
        <p className="text-xs text-muted-foreground">
          {slots.flexible
            ? "Flexible: book any time."
            : slots.windows.length
              ? `Working hours ${slots.windows.map((w) => `${w.start}–${w.end}${w.kind === "procedure" ? " (procedures)" : ""}`).join(", ")}.`
              : ""}
          {customTime ? " Custom time on — this visit is booked outside them." : ""}
          {slots.remaining !== null
            ? ` ${slots.remaining} of ${slots.limit} appointment${slots.remaining === 1 ? "" : "s"} left that day.`
            : ""}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || !scheduledAt}>
          {pending
            ? isEdit
              ? "Saving…"
              : "Scheduling…"
            : isEdit
              ? "Save changes"
              : "Schedule appointment"}
        </Button>
      </div>

      {/* Failed create/edit → error toast (re-triggered per attempt via nonce). */}
      <Toast message={state.error ?? null} variant="error" token={errorNonce} />
      {/* Edit success → stay on the edit form, show a saved toast (re-triggered per
          save). Create instead redirects to the new appointment's detail page. */}
      <Toast
        message={state.saved ? "Changes saved." : null}
        token={savedNonce}
      />
    </form>
  );
}
