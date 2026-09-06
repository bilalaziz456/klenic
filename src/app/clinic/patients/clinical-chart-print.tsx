import { getPatientHeader } from "@/core/patients/list";
import { getClinic } from "@/core/clinics/get-clinic";
import Link from "next/link";
import { notFound } from "next/navigation";
import { clinicalRecordFor } from "@/config/modules";
import { formatMrn } from "@/core/patients/mrn";
import { InvoicePrintFrame } from "@/core/ui/invoice-print";

/**
 * Printable clinical chart — the patient's current odontogram + latest perio summary,
 * for the record/referral. Renders the enabled module's read-only chart via the
 * contract (core never knows it's dental). Gated by the caller (`clinical:view`).
 */
export async function ClinicalChartPrint({
  clinicId,
  patientId,
  backHref,
}: {
  clinicId: string;
  patientId: string;
  backHref: string;
}) {
  const patient = await getPatientHeader(clinicId, patientId);
  if (!patient) notFound();

  const clinic = await getClinic(clinicId);
  const mrnLabel = formatMrn(clinic?.mrnPrefix, patient.mrn, patient.createdAt);

  const clinicalRecord = clinicalRecordFor(clinic?.modulesEnabled ?? []);
  if (!clinicalRecord) notFound();

  const chart = await clinicalRecord.loadChart(clinicId, patientId);
  const perioTrend = clinicalRecord.perio ? await clinicalRecord.perio.trend(clinicId, patientId) : [];
  const latestPerio = perioTrend.length ? perioTrend[perioTrend.length - 1] : null;
  const ChartView = clinicalRecord.PatientChart;
  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

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
            <div className="text-[0.9em] opacity-70">Clinical chart</div>
          </div>
          <div className="text-right text-[0.9em]">{today}</div>
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

        <div className="mt-3">
          <ChartView chart={chart} />
        </div>

        {latestPerio ? (
          <div className="mt-3 border-t border-black/20 pt-2 text-[0.9em]">
            <span className="font-medium">Periodontal (latest): </span>
            BOP {latestPerio.bop}% · deepest pocket {latestPerio.maxPocket} mm
          </div>
        ) : null}

        <div className="mt-3 border-t border-black/20 pt-2 text-center text-[0.8em] opacity-70">
          {clinic?.whatsappSignature ? <div>{clinic.whatsappSignature}</div> : null}
        </div>
      </InvoicePrintFrame>
    </div>
  );
}
