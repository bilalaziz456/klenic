"use client";

import { useActionState, useState } from "react";
import { Button } from "@/core/ui/button";
import { Toast } from "@/core/ui/toast";
import { cn } from "@/core/lib/utils";
import { setClinicPrintPaper, type SettingsActionState } from "./actions";

const PAPERS = [
  { value: "thermal", label: "Thermal", hint: "80mm roll printer" },
  { value: "a5", label: "A5", hint: "148mm sheet" },
  { value: "a4", label: "A4", hint: "210mm sheet" },
];

/**
 * The clinic's print sizes: which ones staff are OFFERED, and which opens first.
 *
 * Two settings rather than one, because they are genuinely different questions. The
 * default only decided what the print screen opened on; every size was still offered
 * on every print, so a clinic with one thermal printer saw A5 on every invoice and a
 * receptionist could pick it by accident. Turning a size off removes the button.
 *
 * The default is chosen from among the ENABLED sizes only — a default that is not
 * offered is a screen opening on a button that is not there. Turning off the current
 * default therefore moves it rather than leaving it dangling, and the last enabled
 * size cannot be turned off at all: its checkbox is disabled here and the action
 * refuses it server-side, because a clinic that can print nothing is the one outcome
 * this must never produce.
 */
export function PrintingForm({ paper, enabled }: { paper: string; enabled: string[] }) {
  const [state, action, pending] = useActionState<SettingsActionState, FormData>(
    setClinicPrintPaper,
    {},
  );
  const known = (list: string[]) => list.filter((v) => PAPERS.some((p) => p.value === v));
  const [on, setOn] = useState<string[]>(() => {
    const k = known(enabled);
    return k.length > 0 ? k : ["a4"];
  });
  const [sel, setSel] = useState(() => (PAPERS.some((p) => p.value === paper) ? paper : "a4"));

  const toggle = (value: string) => {
    setOn((prev) => {
      if (!prev.includes(value)) return [...prev, value];
      if (prev.length === 1) return prev; // never empty
      const next = prev.filter((v) => v !== value);
      // Turning off the current default moves it to one that is still offered.
      if (sel === value) setSel(next[0]);
      return next;
    });
  };

  const dirty =
    sel !== paper ||
    on.length !== known(enabled).length ||
    on.some((v) => !known(enabled).includes(v));

  return (
    <form action={action} className="space-y-4">
      {on.map((v) => (
        <input key={v} type="hidden" name="papers" value={v} />
      ))}
      <input type="hidden" name="paper" value={sel} />

      <div className="space-y-2">
        <p className="text-sm font-medium">Sizes you use</p>
        <p className="text-xs text-muted-foreground">
          Only these appear on the print screens. Turn off a size you have no printer
          for, so nobody picks it by mistake.
        </p>
        <div className="flex flex-wrap gap-2">
          {PAPERS.map((p) => {
            const isOn = on.includes(p.value);
            const isLast = isOn && on.length === 1;
            return (
              <label
                key={p.value}
                className={cn(
                  "flex min-w-28 cursor-pointer flex-col rounded-lg border px-3 py-2 transition-colors",
                  isOn ? "border-primary bg-primary/10" : "hover:bg-accent",
                  isLast && "cursor-not-allowed opacity-70",
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={isOn}
                    disabled={isLast}
                    onChange={() => toggle(p.value)}
                    className="size-4 accent-[var(--color-primary)]"
                  />
                  {p.label}
                </span>
                <span className="pl-6 text-xs text-muted-foreground">{p.hint}</span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Opens by default</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Default paper size">
          {PAPERS.filter((p) => on.includes(p.value)).map((p) => (
            <button
              key={p.value}
              type="button"
              role="radio"
              aria-checked={sel === p.value}
              onClick={() => setSel(p.value)}
              className={cn(
                "rounded-lg border px-3 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                sel === p.value ? "border-primary bg-primary/10" : "hover:bg-accent",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {on.length === 1
            ? "Only one size is on, so the print screens show no size picker at all."
            : "Staff can still switch between the sizes above on any print."}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant="outline" disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {state.error ? <span className="text-sm text-destructive">{state.error}</span> : null}
      </div>
      <Toast
        message={state.saved ? "Saved." : state.error ?? null}
        variant={state.error ? "error" : "success"}
        token={state.saved ? 1 : 0}
      />
    </form>
  );
}
