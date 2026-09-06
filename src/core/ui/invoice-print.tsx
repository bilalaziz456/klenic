"use client";

import { useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/core/ui/button";
import { cn } from "@/core/lib/utils";
import { BRAND_POWERED_BY } from "@/core/lib/brand";

/** Paper formats: browser `@page` size + on-screen sheet width/scale + logo height. */
const FORMATS = {
  thermal: { label: "Thermal", page: "80mm auto", margin: "3mm", width: "80mm", font: "11px", logoH: "40px" },
  a5: { label: "A5", page: "A5", margin: "10mm", width: "148mm", font: "12px", logoH: "52px" },
  a4: { label: "A4", page: "A4", margin: "14mm", width: "210mm", font: "13px", logoH: "64px" },
} as const;
type Fmt = keyof typeof FORMATS;

/**
 * Print frame for a document (invoice/receipt) — a Thermal / A5 / A4 selector, a
 * Print/Save-PDF button, and per-format print CSS (`@page size`, chrome hidden).
 * The document JSX is passed as children (server-rendered) and shown on a white
 * "paper" sheet sized to the chosen format. Save-as-PDF is the browser's print path.
 */
export function InvoicePrintFrame({
  defaultFormat = "a4",
  allowed,
  logo = null,
  children,
}: {
  defaultFormat?: string;
  /**
   * The sizes this clinic actually uses (`clinics.invoice_papers_enabled`). Omitted
   * means all of them, which is what the admin-side print screens want — FlexicaAI's
   * own subscription invoices are not a clinic's document and are not governed by a
   * clinic's printer.
   */
  allowed?: readonly string[];
  /** Clinic logo as a `data:` URI (server-inlined). Printed in B&W at the top; null = none. */
  logo?: string | null;
  children: React.ReactNode;
}) {
  const all = Object.keys(FORMATS) as Fmt[];
  // An unknown or empty list falls back to everything rather than to nothing: a
  // misconfigured clinic should still be able to print.
  const offered = (() => {
    const picked = all.filter((k) => allowed?.includes(k));
    return picked.length > 0 ? picked : all;
  })();
  const [fmt, setFmt] = useState<Fmt>(() => {
    const wanted = defaultFormat as Fmt;
    return offered.includes(wanted) ? wanted : offered[0];
  });
  const f = FORMATS[offered.includes(fmt) ? fmt : offered[0]];
  const css = `@media print {
  @page { size: ${f.page}; margin: ${f.margin}; }
  aside, header { display: none !important; }
  main { padding: 0 !important; max-width: none !important; }
  .no-print { display: none !important; }
  .invoice-sheet { width: auto !important; border: 0 !important; box-shadow: none !important; padding: 0 !important; }
}`;

  return (
    <div>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        {offered.length > 1 ? (
          <>
            <span className="text-xs text-muted-foreground">Format</span>
            {offered.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={fmt === k}
                onClick={() => setFmt(k)}
                className={cn(
                  "rounded-lg border px-3 py-1 text-sm transition-colors",
                  fmt === k ? "border-primary bg-primary/10" : "hover:bg-accent",
                )}
              >
                {FORMATS[k].label}
              </button>
            ))}
          </>
        ) : null}
        <Button size="sm" onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden="true" /> Print / Save PDF
        </Button>
      </div>

      <div
        className="invoice-sheet mx-auto rounded-md border bg-white text-black shadow-sm"
        style={{
          width: `min(100%, ${f.width})`,
          // The sheet's padding IS the page margin. A flat 20px made the preview
          // narrower than the real page on thermal (3mm) and wider on A4 (14mm), so
          // content that fits the paper could wrap differently on screen — which is
          // the one thing a print preview must not do.
          padding: f.margin,
          fontSize: f.font,
        }}
      >
        {/* Clinic logo — always black & white; sized to the paper format. */}
        {logo ? (
          <div className="mb-2 flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={logo}
              alt=""
              className="object-contain"
              style={{
                maxHeight: f.logoH,
                maxWidth: "70%",
                // Print the logo AS UPLOADED — the printer handles B&W conversion
                // (thermal/mono renders it black & white with proper dithering; a
                // colour printer keeps colour). Forcing a CSS filter either muddies
                // it (grayscale) or destroys detail (brightness 0).
                WebkitPrintColorAdjust: "exact",
                printColorAdjust: "exact",
              }}
            />
          </div>
        ) : null}
        {children}
        {/* Brand credit — printed at the foot of every document that uses this frame. */}
        <div className="mt-4 border-t border-black/10 pt-2 text-center text-[0.7em] opacity-60">
          {BRAND_POWERED_BY}
        </div>
      </div>
    </div>
  );
}
