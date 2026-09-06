import { getClinic } from "@/core/clinics/get-clinic";
import { getPatientHeader } from "@/core/patients/list";
import { getTreatmentPlan, listTreatmentPlanItems } from "@/core/patients/treatment-plans";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatPkr } from "@/core/appointments/fee";
import { formatMrn } from "@/core/patients/mrn";
import { InvoicePrintFrame } from "@/core/ui/invoice-print";

/**
 * Printable treatment-plan ESTIMATE (a patient-facing quote). Thermal/A5/A4 via the
 * shared print frame. Lists the plan's items (tooth, qty, price) + total. Gated by
 * the caller (`plans:view`); clinic-scoped. Prices are the plan-item snapshots.
 */
export async function TreatmentEstimate({
  clinicId,
  patientId,
  planId,
  backHref,
}: {
  clinicId: string;
  patientId: string;
  planId: string;
  backHref: string;
}) {
  const plan = await getTreatmentPlan(clinicId, planId);
  if (!plan) notFound();

  const patient = await getPatientHeader(clinicId, patientId);
  if (!patient) notFound();

  const clinic = await getClinic(clinicId);
  const mrnLabel = formatMrn(clinic?.mrnPrefix, patient.mrn, patient.createdAt);

  const items = await listTreatmentPlanItems(clinicId, planId);

  const total = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const fmtDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="no-print">
        <Link href={backHref} className="text-sm text-muted-foreground underline underline-offset-4">
          ← Back to patient
        </Link>
      </div>

      <InvoicePrintFrame
        defaultFormat={clinic?.invoicePaper ?? "a4"}
        allowed={clinic?.invoicePapersEnabled}
      >
        <div className="flex items-start justify-between gap-3 border-b border-black/20 pb-2">
          <div>
            <div className="text-base font-bold">{clinic?.name ?? "Clinic"}</div>
            <div className="text-[0.9em] opacity-70">Treatment estimate</div>
          </div>
          <div className="text-right text-[0.9em]">
            <div className="font-semibold">{plan.title}</div>
            <div>{fmtDate(plan.createdAt)}</div>
          </div>
        </div>

        <div className="mt-2 text-[0.95em]">
          <span className="opacity-70">Patient: </span>
          <span className="font-medium">{patient.fullName}</span>
          {patient.phone ? <span className="opacity-70"> · {patient.phone}</span> : null}
        </div>
        {mrnLabel ? (
          <div className="text-[0.95em]">
            <span className="opacity-70">MRN#: </span>
            <span className="tabular-nums">{mrnLabel}</span>
          </div>
        ) : null}

        {items.length > 0 ? (
          <table className="mt-3 w-full border-collapse text-[0.95em]">
            <thead>
              <tr className="border-b border-black/20 text-left">
                <th className="py-1 font-normal opacity-70">Treatment</th>
                <th className="py-1 text-center font-normal opacity-70">Tooth</th>
                <th className="py-1 text-right font-normal opacity-70">Qty</th>
                <th className="py-1 text-right font-normal opacity-70">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-b border-black/10">
                  <td className="py-1">{it.name}</td>
                  <td className="py-1 text-center">{it.tooth ?? "—"}</td>
                  <td className="py-1 text-right">{it.quantity}</td>
                  <td className="py-1 text-right tabular-nums">{formatPkr(it.unitPrice * it.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-3 text-[0.9em] opacity-70">No items on this plan.</p>
        )}

        <div className="mt-2 flex justify-between border-t border-black/20 pt-1 text-[1.05em] font-bold">
          <span>Estimated total</span>
          <span className="tabular-nums">{formatPkr(total)}</span>
        </div>

        {plan.note ? <p className="mt-2 text-[0.9em] opacity-80">{plan.note}</p> : null}

        <div className="mt-3 border-t border-black/20 pt-2 text-center text-[0.8em] opacity-70">
          <div>This is an estimate. The final cost may vary with treatment.</div>
          {clinic?.whatsappSignature ? <div>{clinic.whatsappSignature}</div> : null}
        </div>
      </InvoicePrintFrame>
    </div>
  );
}
