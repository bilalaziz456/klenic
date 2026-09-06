"use client";

import { useActionState, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  deleteStaff,
  resetStaffPassword,
  updateDoctorShares,
  updateStaffProfile,
  type ClinicActionState,
} from "@/app/clinic/actions";
import { Button } from "@/core/ui/button";
import { ConfirmDeleteDialog } from "@/core/ui/confirm-delete-dialog";
import { Input } from "@/core/ui/input";
import { PasswordInput } from "@/core/ui/password-input";
import { Label } from "@/core/ui/label";
import { Toast } from "@/core/ui/toast";
import { DoctorScheduleFields } from "@/app/clinic/doctor-schedule-fields";
import type { DayAvailability } from "@/core/lib/availability";
import { STAFF_PREFIXES } from "@/core/types/auth";
import { syncChecked } from "@/core/ui/checkbox-sync";

/**
 * Edit a staff member in ONE save — name + username, plus (for doctors) the
 * working-hours schedule, daily cap and fee. Mirrors the create form; the other
 * staff controls (password, suspend, delete, leave) stay as separate actions.
 */
export function EditStaffForm({
  userId,
  prefix,
  fullName,
  username,
  role,
  availability,
  dailyLimit,
  fee,
  flexibleHours,
}: {
  userId: string;
  prefix: string | null;
  fullName: string | null;
  username: string;
  role: string;
  availability: DayAvailability[];
  dailyLimit: number;
  fee: number;
  flexibleHours: boolean;
}) {
  const action = updateStaffProfile.bind(null, userId);
  const [state, formAction, pending] = useActionState<
    ClinicActionState,
    FormData
  >(action, {});
  // Both outcomes toast in place — the save no longer bounces to the staff list.
  // The nonces let an identical message fire again on a repeated save, since
  // useActionState hands back an equal state object each time.
  const [savedNonce, setSavedNonce] = useState(0);
  const [errorNonce, setErrorNonce] = useState(0);
  useEffect(() => {
    if (state.saved) setSavedNonce((n) => n + 1);
    if (state.error) setErrorNonce((n) => n + 1);
  }, [state]);
  const isDoctor = role === "doctor";
  const [scheduleValid, setScheduleValid] = useState(true);

  return (
    <form action={formAction} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="fullName">Full name</Label>
          <div className="flex gap-2">
            <select
              key={`prefix-${prefix ?? ""}`}
              name="prefix"
              aria-label="Title"
              defaultValue={prefix ?? ""}
              className="h-8 w-24 shrink-0 rounded-lg border border-input bg-[var(--input-bg)] pl-2.5 pr-8 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 select-chevron"
            >
              <option value="">Title</option>
              {STAFF_PREFIXES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <Input
              key={`name-${fullName ?? ""}`}
              id="fullName"
              name="fullName"
              defaultValue={fullName ?? ""}
              className="flex-1"
              required
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="username">Username</Label>
          <Input
            key={`user-${username}`}
            id="username"
            name="username"
            defaultValue={username}
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        </div>
      </div>

      {isDoctor ? (
        <div className="space-y-3 border-t pt-4">
          <p className="text-sm font-medium">Schedule &amp; fees</p>
          <DoctorScheduleFields
            defaultAvailability={availability}
            defaultLimit={dailyLimit}
            defaultFee={fee}
            defaultFlexible={flexibleHours}
            onValidChange={setScheduleValid}
          />
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || (isDoctor && !scheduleValid)}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
      <Toast
        message={state.saved ? "Staff member updated." : null}
        variant="success"
        token={savedNonce}
      />
      <Toast message={state.error ?? null} variant="error" token={errorNonce} />
    </form>
  );
}

/**
 * A doctor's REVENUE-SHARE config — the cut they earn of the consultation fee and
 * of procedures, plus per-procedure rate overrides and their discount-approval
 * switch. Empty override = "use the default rate"; a typed 0 is an explicit 0%
 * (distinct from empty). Saved in one action; stays on the page with a toast.
 */
export function DoctorSharesForm({
  userId,
  consultationSharePct,
  procedureSharePct,
  discountNeedsApproval,
  procedures,
  initialOverrides,
}: {
  userId: string;
  consultationSharePct: number;
  procedureSharePct: number;
  discountNeedsApproval: boolean;
  procedures: { id: string; name: string; price: number }[];
  initialOverrides: Record<string, number>;
}) {
  const action = updateDoctorShares.bind(null, userId);
  const [state, formAction, pending] = useActionState<
    ClinicActionState,
    FormData
  >(action, {});
  const [savedNonce, setSavedNonce] = useState(0);
  const [errorNonce, setErrorNonce] = useState(0);
  useEffect(() => {
    if (state.saved) setSavedNonce((n) => n + 1);
    if (state.error) setErrorNonce((n) => n + 1);
  }, [state]);

  const [consult, setConsult] = useState(String(consultationSharePct));
  const [defaultProc, setDefaultProc] = useState(String(procedureSharePct));
  const [needsApproval, setNeedsApproval] = useState(discountNeedsApproval);
  // Per-procedure override as a STRING so empty ("inherit default") stays distinct
  // from "0" (explicit 0%). Only non-empty entries submit an `override` field.
  const [overrides, setOverrides] = useState<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const [id, pct] of Object.entries(initialOverrides)) m.set(id, String(pct));
    return m;
  });
  const setOverride = (id: string, v: string) =>
    setOverrides((prev) => {
      const next = new Map(prev);
      const clean = v.replace(/[^\d]/g, "");
      if (clean === "") next.delete(id);
      else next.set(id, String(Math.min(100, Number(clean))));
      return next;
    });

  const pctField =
    "h-8 w-20 rounded-lg border border-input bg-[var(--input-bg)] px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

  return (
    <form action={formAction} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="consultationSharePct">Consultation share (%)</Label>
          <input
            id="consultationSharePct"
            name="consultationSharePct"
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            value={consult}
            onChange={(e) => setConsult(e.target.value.replace(/[^\d]/g, ""))}
            className={pctField}
          />
          <p className="text-xs text-muted-foreground">
            The doctor&apos;s cut of their consultation fee.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="procedureSharePct">Default procedure share (%)</Label>
          <input
            id="procedureSharePct"
            name="procedureSharePct"
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            value={defaultProc}
            onChange={(e) => setDefaultProc(e.target.value.replace(/[^\d]/g, ""))}
            className={pctField}
          />
          <p className="text-xs text-muted-foreground">
            Applied to any procedure without a specific rate below.
          </p>
        </div>
      </div>

      {procedures.length > 0 ? (
        <div className="space-y-2 border-t pt-4">
          <p className="text-sm font-medium">Per-procedure rates</p>
          <p className="text-xs text-muted-foreground">
            Leave blank to use the default ({defaultProc || 0}%). Enter 0 for an
            explicit 0% (all to the clinic).
          </p>
          <ul className="divide-y rounded-lg border">
            {procedures.map((p) => {
              const v = overrides.get(p.id) ?? "";
              return (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate font-medium">{p.name}</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={100}
                      value={v}
                      onChange={(e) => setOverride(p.id, e.target.value)}
                      placeholder={`${defaultProc || 0}`}
                      aria-label={`${p.name} share percent`}
                      className={pctField}
                    />
                    <span className="text-muted-foreground">%</span>
                  </div>
                </li>
              );
            })}
          </ul>
          {/* Only non-empty overrides submit (empty = inherit the default). */}
          {[...overrides.entries()].map(([id, pct]) => (
            <input key={id} type="hidden" name="override" value={`${id}:${pct}`} />
          ))}
        </div>
      ) : null}

      <div className="space-y-2 border-t pt-4">
        <input type="hidden" name="discountNeedsApproval" value={needsApproval ? "on" : ""} />
        <label className="flex min-h-6 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={needsApproval}
            ref={syncChecked(needsApproval)}
            onChange={(e) => setNeedsApproval(e.target.checked)}
            className="size-4 accent-[var(--color-primary)]"
          />
          Discounts taken from this doctor&apos;s share need their approval
        </label>
        <p className="text-xs text-muted-foreground">
          When on, a discount that reduces this doctor&apos;s earnings waits for their
          approval before it applies. The doctor can also change this themselves.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save revenue share"}
        </Button>
      </div>
      {/* The message must be null until a save has actually happened. <Toast> fires
          whenever `message` is non-empty and its (variant, token, message) key differs
          from the last one pushed — and that key starts out null, so a CONSTANT string
          here announced "Revenue share saved." the moment the page opened. `token`
          alone does not gate it; it only lets an identical message fire a second time.
          The error toast below already had this shape. */}
      <Toast
        message={state.saved ? "Revenue share saved." : null}
        variant="success"
        token={savedNonce}
      />
      <Toast message={state.error ?? null} variant="error" token={errorNonce} />
    </form>
  );
}

/** Reset the staff member's password to a new temporary one. */
export function ResetPasswordForm({ userId }: { userId: string }) {
  const action = resetStaffPassword.bind(null, userId);
  const [state, formAction, pending] = useActionState<
    ClinicActionState,
    FormData
  >(action, {});

  return (
    <form action={formAction} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="new-temp-password" className="text-xs">
            New temporary password
          </Label>
          <PasswordInput
            id="new-temp-password"
            name="password"
            defaultVisible
            placeholder="At least 8 characters"
            className="w-64"
            required
          />
        </div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Setting…" : "Reset password"}
        </Button>
      </div>
      {state.saved ? (
        <p className="text-sm text-emerald-600" role="status">
          Temporary password set. They must change it at next login.
        </p>
      ) : null}
      {state.error ? (
        <p className="text-sm text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** Delete the staff member (step-up password), then return to the list. */
/**
 * `openDrafts` is the count of unapproved notes this person dictated. Deleting them
 * ends their login, and a draft can only ever be reopened by its author (ADR-007) —
 * so those notes become unreachable by everyone, including the admin doing this. The
 * admin cannot be expected to infer that, hence the count is stated before they
 * confirm rather than discovered when a patient's record turns out to be missing one.
 */
export function DeleteStaffButton({
  userId,
  label,
  openDrafts = 0,
}: {
  userId: string;
  label: string;
  openDrafts?: number;
}) {
  return (
    <ConfirmDeleteDialog
      triggerLabel="Delete staff member"
      triggerVariant="destructive"
      triggerIcon={<Trash2 className="size-4" aria-hidden="true" />}
      title="Delete staff member"
      description={`Permanently delete ${label}. Their sessions end immediately; visit history is kept.`}
      warning={
        openDrafts > 0
          ? `${label} has ${openDrafts} unapproved ${openDrafts === 1 ? "note" : "notes"}. Only the clinician who dictated a note can approve it, so deleting this account leaves ${openDrafts === 1 ? "it" : "them"} unreachable — ${openDrafts === 1 ? "it" : "they"} will not reach the patient's record, and will not appear in Trash. Have ${label} review ${openDrafts === 1 ? "it" : "them"} first, or suspend the account instead (that is reversible).`
          : undefined
      }
      onConfirm={(password) => deleteStaff(userId, password)}
    />
  );
}
