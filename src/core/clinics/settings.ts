import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/core/db";
import { clinics } from "@/core/db/schema";
import type { InvoicePaperCode } from "@/core/db/vocabulary-seed";
import type { ClinicHour } from "@/core/lib/clinic-hours";

/**
 * Clinic-owned settings a clinic admin changes about THEIR OWN clinic — CORE per
 * ADR-014. Distinct from `core/admin/*`, which is the company changing settings about
 * a clinic: same table, different authority, and keeping them apart is what stops a
 * clinic-side action growing a field only the super admin should set.
 *
 * Takes `clinicId` first and filters on it, so a caller cannot write to another
 * tenant's row even by mistake.
 */
/**
 * The clinic's print sizes: which are OFFERED, and which of them opens first.
 *
 * Written together on purpose. They are two halves of one decision, and setting them
 * separately is what would let a clinic end up defaulting to a size it no longer
 * offers — a print screen that opens on a button that is not there.
 *
 * TWO INVARIANTS, enforced here rather than trusted from the caller, because this is
 * the last place before the write and a clinic that cannot print anything is a far
 * worse outcome than a rejected form:
 *   1. the list is never empty — an empty list means no print button at all;
 *   2. the default is always one of the enabled sizes.
 * Both are also checked in the action for a decent error message; this is the backstop
 * that holds if anything else ever calls in.
 */
export async function setInvoicePapers(
  clinicId: string,
  enabled: InvoicePaperCode[],
  fallbackDefault: InvoicePaperCode,
): Promise<void> {
  const papers = enabled.length > 0 ? enabled : [fallbackDefault];
  const paper = papers.includes(fallbackDefault) ? fallbackDefault : papers[0];
  await db
    .update(clinics)
    .set({ invoicePapersEnabled: papers, invoicePaper: paper, updatedAt: new Date() })
    .where(eq(clinics.id, clinicId));
}

/** The clinic's WhatsApp message footer. */
export async function setWhatsappSignature(
  clinicId: string,
  signature: string | null,
): Promise<void> {
  await db
    .update(clinics)
    .set({ whatsappSignature: signature, updatedAt: new Date() })
    .where(eq(clinics.id, clinicId));
}

/** The clinic's average visit value — the multiplier behind "Revenue Recovered". */
export async function setAvgVisitValue(clinicId: string, value: number): Promise<void> {
  await db
    .update(clinics)
    .set({ avgVisitValue: value, updatedAt: new Date() })
    .where(eq(clinics.id, clinicId));
}

/** Whether CLINIC-borne discounts need sign-off before they apply. */
export async function setDiscountNeedsApproval(
  clinicId: string,
  requireApproval: boolean,
): Promise<void> {
  await db
    .update(clinics)
    .set({ discountNeedsApproval: requireApproval, updatedAt: new Date() })
    .where(eq(clinics.id, clinicId));
}

/**
 * The clinic's PUBLIC contact details — the address and opening hours a patient is
 * told over WhatsApp. Edited by the clinic admin, about their own clinic.
 *
 * Blank means "we have not said", and the WhatsApp reply omits it rather than
 * printing an empty line: a patient told nothing is better served by reaching a
 * person than by an answer with a hole in it.
 */
export async function setPublicContact(
  clinicId: string,
  values: { publicAddress: string | null; openingHours: ClinicHour[] | null },
): Promise<void> {
  await db
    .update(clinics)
    .set({
      publicAddress: values.publicAddress,
      openingHours: values.openingHours,
      updatedAt: new Date(),
    })
    .where(eq(clinics.id, clinicId));
}
