"use server";

import { revalidatePath } from "next/cache";
import { setInvoicePapers, setPublicContact } from "@/core/clinics/settings";
import { z } from "zod";
import { zodErrorMessage } from "@/core/lib/zod-error";
import { clinicHoursSchema } from "@/core/lib/clinic-hours";
import { requireWorkspace } from "@/core/auth/user";
import { logActivity } from "@/core/audit/log";
import { asCode, INVOICE_PAPER_ROWS, type InvoicePaperCode } from "@/core/db/vocabulary-seed";

export type SettingsActionState = { error?: string; saved?: boolean };

/** The address is free text; the hours arrive as JSON from the day editor. */
const publicContactSchema = z.object({
  publicAddress: z.string().max(400, "Address is too long (400 characters max)."),
});

/** Valid document paper sizes — must match the print frame's FORMATS. */


/**
 * The clinic's print sizes — which are OFFERED on every print screen, and which opens
 * first. Clinic-admin only, like the rest of this card.
 *
 * TWO THINGS, one form, because they constrain each other: a default that is not
 * offered is a print screen opening on a button that is not there. Rejected here with
 * a message the admin can act on; `setInvoicePapers` re-applies both rules as a
 * backstop.
 */
export async function setClinicPrintPaper(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const user = await requireWorkspace();
  if (user.role !== "clinic_admin" || !user.clinicId) {
    return { error: "Only the clinic admin can change the printing settings." };
  }

  const enabled = formData
    .getAll("papers")
    .map((v) => asCode<InvoicePaperCode>(INVOICE_PAPER_ROWS, String(v)))
    .filter((c): c is InvoicePaperCode => Boolean(c));
  // Never let a clinic switch every size off: the print screens would offer nothing.
  if (enabled.length === 0) return { error: "Keep at least one paper size." };

  const paper = asCode<InvoicePaperCode>(INVOICE_PAPER_ROWS, String(formData.get("paper") ?? ""));
  if (!paper) return { error: "Choose a valid paper size." };
  if (!enabled.includes(paper)) {
    return { error: "The default size must be one of the sizes you use." };
  }

  await setInvoicePapers(user.clinicId, enabled, paper);

  await logActivity({
    action: "update",
    entity: "settings",
    clinicId: user.clinicId,
    summary: `Print sizes set to ${enabled.join(", ").toUpperCase()} (default ${paper.toUpperCase()})`,
  });
  revalidatePath("/clinic/settings");
  return { saved: true };
}

/**
 * The clinic's PUBLIC address and opening hours — what a patient is told over
 * WhatsApp. Clinic-admin only, like the printing default: it is a statement the
 * clinic makes about itself, not a per-user preference.
 *
 * Blank clears the field. An empty value is meaningful — it means "we have not said"
 * — so it is stored as NULL rather than an empty string, and the reply then omits
 * that line entirely instead of printing a heading with nothing under it.
 */
export async function setClinicPublicContact(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const user = await requireWorkspace();
  if (user.role !== "clinic_admin" || !user.clinicId) {
    return { error: "Only the clinic admin can change the clinic's public details." };
  }

  const parsed = publicContactSchema.safeParse({
    publicAddress: formData.get("publicAddress") ?? "",
  });
  if (!parsed.success) return { error: zodErrorMessage(parsed.error) };

  // The hours are jsonb written from a browser, so they are validated, not trusted
  // (conventions §4). Invalid JSON is a client bug, not something to store.
  let rawHours: unknown = [];
  try {
    rawHours = JSON.parse(String(formData.get("openingHours") ?? "[]"));
  } catch {
    return { error: "Could not read the opening hours. Please try again." };
  }
  const hours = clinicHoursSchema.safeParse(rawHours);
  if (!hours.success) return { error: zodErrorMessage(hours.error) };

  const publicAddress = parsed.data.publicAddress.trim() || null;
  // No windows at all means "not stated", which the reply omits — distinct from a
  // clinic that IS open some days and closed others.
  const openingHours = hours.data.length > 0 ? hours.data : null;
  await setPublicContact(user.clinicId, { publicAddress, openingHours });

  await logActivity({
    action: "update",
    entity: "settings",
    clinicId: user.clinicId,
    // No values in the summary: an address is the clinic's, but the log is read by
    // staff and there is no reason to copy it into a second place.
    summary: "Updated the clinic's public address and opening hours",
  });
  revalidatePath("/clinic/settings");
  return { saved: true };
}
