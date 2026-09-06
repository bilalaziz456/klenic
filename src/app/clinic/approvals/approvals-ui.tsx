"use client";

import { useActionState, useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import {
  decideApproval,
  updateClinicDiscountPolicy,
  type ApprovalActionState,
} from "./actions";
import { Button } from "@/core/ui/button";
import { Toast } from "@/core/ui/toast";
import { syncChecked } from "@/core/ui/checkbox-sync";

export type QueueItem = {
  id: string;
  appointmentId: string;
  approverKind: string;
  patientName: string | null;
  scheduledAt: string; // preformatted
  discountLabel: string; // e.g. "Rs 500 · borne by Doctor"
  mine: boolean; // true = a doctor's own-share row
};

/** Clinic admin's switch: do CLINIC-borne discounts need approval before applying? */
export function ClinicDiscountPolicy({ initial }: { initial: boolean }) {
  const [state, formAction, pending] = useActionState<ApprovalActionState, FormData>(
    updateClinicDiscountPolicy,
    {},
  );
  const [on, setOn] = useState(initial);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (state.saved || state.error) setNonce((n) => n + 1);
  }, [state]);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="requireApproval" value={on ? "on" : ""} />
      <label className="flex min-h-6 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={on}
          ref={syncChecked(on)}
          onChange={(e) => setOn(e.target.checked)}
          className="size-4 accent-[var(--color-primary)]"
        />
        Clinic-borne discounts need approval before they apply
      </label>
      <p className="text-xs text-muted-foreground">
        When on, a discount the clinic absorbs waits for a sign-off here. Each doctor
        controls approval for discounts off their own share separately.
      </p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
      <Toast
        message={state.saved ? "Saved." : state.error ?? null}
        variant={state.error ? "error" : "success"}
        token={nonce}
      />
    </form>
  );
}

/** One pending approval with a note field and Approve / Reject buttons. */
function ApprovalRow({ item }: { item: QueueItem }) {
  const [state, formAction, pending] = useActionState<ApprovalActionState, FormData>(
    decideApproval,
    {},
  );
  const [errNonce, setErrNonce] = useState(0);
  useEffect(() => {
    if (state.error) setErrNonce((n) => n + 1);
  }, [state]);

  return (
    <li className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{item.patientName ?? "Patient"}</p>
          <p className="text-xs text-muted-foreground">{item.scheduledAt}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-medium">{item.discountLabel}</p>
          <p className="text-xs text-muted-foreground">
            {item.mine ? "Off your share" : "Clinic-borne"}
          </p>
        </div>
      </div>
      <form action={formAction} className="space-y-2">
        <input type="hidden" name="rowId" value={item.id} />
        <input
          type="text"
          name="note"
          // A placeholder is not an accessible name: it is gone the moment you type,
          // and it is not reliably announced. Every other field in these forms has a
          // visible <label htmlFor>; this one sits full width under the grid and was
          // missed. aria-label rather than a visible label because this form repeats
          // per approval row and a label on each would double its height.
          aria-label="Note for this decision"
          placeholder="Note (optional)"
          className="h-8 w-full rounded-lg border border-input bg-[var(--input-bg)] px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <div className="flex gap-2">
          <Button
            type="submit"
            name="decision"
            value="approved"
            size="sm"
            disabled={pending}
          >
            <Check className="size-4" aria-hidden="true" /> Approve
          </Button>
          <Button
            type="submit"
            name="decision"
            value="rejected"
            size="sm"
            variant="outline"
            disabled={pending}
          >
            <X className="size-4" aria-hidden="true" /> Reject
          </Button>
        </div>
        <Toast message={state.error ?? null} variant="error" token={errNonce} />
      </form>
    </li>
  );
}

/** The pending-approvals list (empty state included). */
export function ApprovalQueue({ items }: { items: QueueItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No discounts are awaiting approval.</p>
    );
  }
  return (
    <ul className="divide-y rounded-lg border">
      {items.map((it) => (
        <ApprovalRow key={it.id} item={it} />
      ))}
    </ul>
  );
}
