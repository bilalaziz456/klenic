import { getAppointmentForDocument } from "@/core/billing/invoice";
import { getClinic } from "@/core/clinics/get-clinic";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireWorkspace } from "@/core/auth/user";
import { can } from "@/core/auth/permissions";
import { clinicHasFeature } from "@/core/lib/features";
import { getAppointmentProcedureItems } from "@/core/appointments/procedures";
import { getAppointmentBill } from "@/core/billing/bill";
import { listAppointmentPayments } from "@/core/billing/payments";
import { formatReceiptNo } from "@/core/billing/invoice";
import {
  computeBill,
  effectiveDiscountValue,
  formatPkr,
  normalizeDiscountType,
} from "@/core/appointments/fee";
import { displayStaffName } from "@/core/types/auth";
import { formatMrn } from "@/core/patients/mrn";
import { getClinicLogoDataUri } from "@/core/clinics/logo";
import { InvoicePrintFrame } from "@/core/ui/invoice-print";
import { vocabularyLabel } from "@/core/db/vocabulary-cache";

/**
 * Payment receipt for a visit (Finance) — acknowledges money received against this
 * appointment: the individual payments/advances applied, the total paid, and the
 * running balance. Thermal / A5 / A4 via the shared print frame. Gated by the sales
 * feature + billing:view; clinic-scoped. (The invoice is the bill; this is the receipt.)
 */
export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireWorkspace("billing");
  const { clinicId } = user;
  const { id } = await params;

  const row = await getAppointmentForDocument(clinicId, id);
  if (!row) notFound();

  const clinic = await getClinic(clinicId);
  if (!clinicHasFeature(clinic?.featuresEnabled, "sales") || !can(user, "billing", "view")) {
    notFound();
  }
  const mrnLabel = formatMrn(clinic?.mrnPrefix, row.patientMrn, row.patientCreatedAt);
  const logo = await getClinicLogoDataUri(clinic?.logoKey);

  const [aBill, items, ledger] = await Promise.all([
    getAppointmentBill(clinicId, id),
    getAppointmentProcedureItems(clinicId, id),
    listAppointmentPayments(clinicId, id),
  ]);
  // The receipt number (RCP series) + the per-payment breakdown so a partial-payment
  // receipt is self-explanatory under its one number.
  const rcpLabel =
    row.receiptNo != null
      ? formatReceiptNo(clinic?.receiptPrefix, row.receiptYear ?? row.scheduledAt.getFullYear(), row.receiptNo)
      : null;
  const received = ledger.filter((e) => e.kind !== "advance"); // money in/out on THIS visit
  const KIND_LABEL: Record<string, string> = {
    payment: "Payment",
    advance_applied: "Advance applied",
    refund: "Refund",
  };
  // Bill breakdown (consultation + procedures), mirroring the invoice.
  const discountType = normalizeDiscountType(row.discountType);
  const doctorFee = row.chargeConsultation ? (row.doctorFee ?? 0) : 0;
  const bill = computeBill(
    doctorFee,
    items.map((i) => ({
      unitPrice: i.unitPrice,
      quantity: i.quantity,
      discountType: i.discountType,
      discountValue: i.discountValue,
    })),
    discountType,
    effectiveDiscountValue(row.discountStatus, row.discountValue),
  );
  // One numbered charge per row: consultation first, then each procedure (gross).
  const lines = [
    ...(bill.consultation > 0 ? [{ name: "Consultation", qty: 1, amount: bill.consultation }] : []),
    ...items.map((it) => ({ name: it.name, qty: it.quantity, amount: it.unitPrice * it.quantity })),
  ];

  const doctor =
    row.doctorName || row.doctorUsername
      ? displayStaffName(row.doctorPrefix, row.doctorName, row.doctorUsername ?? "")
      : null;
  const fmtDate = (d: Date) =>
    d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="no-print">
        <Link
          href={`/clinic/appointments/${id}`}
          className="text-sm text-muted-foreground underline underline-offset-4"
        >
          ← Back to appointment
        </Link>
      </div>

      <InvoicePrintFrame
        defaultFormat={clinic?.invoicePaper ?? "a4"}
        allowed={clinic?.invoicePapersEnabled}
        logo={logo}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-black/20 pb-2">
          <div>
            <div className="text-base font-bold">{clinic?.name ?? "Clinic"}</div>
            <div className="text-[0.9em] opacity-70">Payment receipt</div>
          </div>
          <div className="text-right text-[0.9em]">
            {rcpLabel ? <div className="font-semibold">{rcpLabel}</div> : null}
            {row.queueNumber != null ? (
              <div className="opacity-70">Appointment #{row.queueNumber}</div>
            ) : null}
            <div>{fmtDate(row.scheduledAt)}</div>
          </div>
        </div>

        {/* Patient */}
        <div className="mt-2 space-y-0.5 text-[0.95em]">
          <div>
            <span className="opacity-70">Patient: </span>
            <span className="font-medium">{row.patientName}</span>
            {row.patientPhone ? <span className="opacity-70"> · {row.patientPhone}</span> : null}
          </div>
          {mrnLabel ? (
            <div>
              <span className="opacity-70">MRN#: </span>
              <span className="tabular-nums">{mrnLabel}</span>
            </div>
          ) : null}
          {doctor ? (
            <div>
              <span className="opacity-70">Doctor: </span>
              {doctor}
            </div>
          ) : null}
        </div>

        {/* Charges — one numbered line per item */}
        <table className="mt-3 w-full border-collapse text-[0.95em]">
          <thead>
            <tr className="border-y border-black/20 text-left">
              <th className="w-6 py-1 pr-2 font-normal opacity-70">#</th>
              <th className="py-1 font-normal opacity-70">Item</th>
              <th className="py-1 text-right font-normal opacity-70">Qty</th>
              <th className="py-1 text-right font-normal opacity-70">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.length > 0 ? (
              lines.map((l, idx) => (
                <tr key={idx}>
                  <td className="py-1 pr-2 tabular-nums opacity-70">{idx + 1}</td>
                  <td className="py-1">{l.name}</td>
                  <td className="py-1 text-right tabular-nums">{l.qty}</td>
                  <td className="py-1 text-right tabular-nums">{formatPkr(l.amount)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td className="py-1 opacity-70" colSpan={4}>No charges recorded.</td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Payments received — each installment under this one receipt number. */}
        {received.length > 0 ? (
          <>
            <div className="mt-3 text-[0.9em] font-semibold opacity-80">Payments received</div>
            <table className="mt-1 w-full border-collapse text-[0.95em]">
              <thead>
                <tr className="border-y border-black/20 text-left">
                  <th className="py-1 font-normal opacity-70">Date</th>
                  <th className="py-1 font-normal opacity-70">Type</th>
                  <th className="py-1 text-right font-normal opacity-70">Amount</th>
                </tr>
              </thead>
              <tbody>
                {received.map((e) => (
                  <tr key={e.id}>
                    <td className="py-1">{fmtDate(e.occurredAt)}</td>
                    <td className="py-1">
                      {KIND_LABEL[e.kind] ?? e.kind}
                      {e.method ? <span className="opacity-70"> · {vocabularyLabel("payment_methods", e.method)}</span> : null}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {e.kind === "refund" ? "−" : ""}
                      {formatPkr(e.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}

        {/* Summary — one money column: charged → paid → due */}
        <div className="mt-3 space-y-1 border-t border-black/20 pt-2 text-[0.95em]">
          {bill.appointmentDiscount > 0 ? (
            <>
              <div className="flex justify-between">
                <span className="opacity-70">Gross amount</span>
                <span className="tabular-nums">{formatPkr(bill.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="opacity-70">Discount</span>
                <span className="tabular-nums">−{formatPkr(bill.appointmentDiscount)}</span>
              </div>
            </>
          ) : null}
          <div className="flex justify-between font-semibold">
            <span>Net amount</span>
            <span className="tabular-nums">{formatPkr(bill.net)}</span>
          </div>
          <div className="flex justify-between">
            <span className="opacity-70">Received</span>
            <span className="tabular-nums">{formatPkr(aBill.collected)}</span>
          </div>
          <div className="flex justify-between border-t-2 border-black/40 pt-1.5 text-[1.15em] font-bold">
            <span>Due</span>
            <span className="tabular-nums">{formatPkr(aBill.outstanding)}</span>
          </div>
        </div>

        <div className="mt-3 border-t border-black/20 pt-2 text-center text-[0.85em] opacity-70">
          {clinic?.whatsappSignature ? <div>{clinic.whatsappSignature}</div> : null}
          <div>Thank you.</div>
        </div>
      </InvoicePrintFrame>
    </div>
  );
}
