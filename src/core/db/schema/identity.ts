import type { ClinicHour } from "@/core/lib/clinic-hours";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DayAvailability } from "@/core/lib/availability";
import { softDeleteColumns } from "@/core/db/schema/_shared";
import {
  USER_ROLE_ROWS,
  THEME_PREFERENCE_ROWS,
  type UserRoleCode,
  type ThemePreferenceCode,
  CLINIC_STATUS_ROWS,
  BILLING_CYCLE_ROWS,
  INVOICE_PAPER_ROWS,
  type ClinicStatusCode,
  type BillingCycleCode,
  type InvoicePaperCode,
} from "@/core/db/vocabulary-seed";
import {
  userRoles,
  themePreferences,
  vocabularyRef,
  clinicStatuses,
  billingCycles,
  invoicePapers,
} from "@/core/db/schema/vocabulary";

/**
 * Tenants and people — clinics, staff, sessions, patients.
 *
 * `clinics` and `users` reference each other, so they share a file: split apart they
 * would be a circular import. `patients` lives here so scheduling and clinical can
 * each depend on it without depending on one another.
 *
 * Part of the schema split (delta D-09) — see `./index.ts`.
 */

/**
 * Tenants. `modulesEnabled` is the array the specialty checkboxes read/write —
 * e.g. ['dental']. Core code checks this list but never hardcodes a specialty.
 */
export const clinics = pgTable(
  "clinics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // text[] of module ids, e.g. {dental}. Empty until a specialty is enabled.
    modulesEnabled: text("modules_enabled")
      .array()
      .notNull()
      .default([]),
    // text[] of optional platform-feature ids the super admin has switched on
    // for this clinic, e.g. {revenue_dashboard}. Specialty-agnostic (works for
    // dental/derma/hair alike) and off by default — see core/lib/features.ts.
    featuresEnabled: text("features_enabled")
      .array()
      .notNull()
      .default([]),
    // text[] of activity-log ACTION categories the clinic admin is allowed to
    // see (e.g. {login,view,update,delete}). Empty = the clinic has NO log
    // access. Granted per-clinic by the super admin — see core/audit/access.ts.
    logAccess: text("log_access").array().notNull().default([]),
    // Owner-set average revenue per visit (whole PKR). Drives the owner
    // dashboard's "Revenue Recovered" metric (recovered return visits × this).
    avgVisitValue: integer("avg_visit_value").notNull().default(3000),
    // How many days a trashed record stays in this clinic's Trash before it drops
    // out of the clinic-level view (still in the DB — only the super admin sees it
    // past this window). Super-admin-set; default 30. Never auto-purged.
    trashRetentionDays: integer("trash_retention_days").notNull().default(30),
    /**
     * How many hours before an appointment a PATIENT may still cancel it themselves
     * over WhatsApp (`whatsapp_cancel` feature). Later than this and the request goes
     * to the front desk instead — cancelling twenty minutes beforehand is a no-show
     * wearing a polite hat, and whether to accept one is a conversation, not a rule.
     *
     * A column and not a constant because clinics disagree about this and it gets
     * negotiated during a sale. 0 disables the cutoff (any time is acceptable).
     */
    cancelCutoffHours: integer("cancel_cutoff_hours").notNull().default(4),
    /**
     * The clinic's PUBLIC contact details — what a patient is told over WhatsApp,
     * edited by the clinic admin on their own settings page.
     *
     * Kept apart from `address` above, which is a super-admin CRM field used as the
     * bill-to line on FlexicaAI's subscription invoices. They are often the same
     * place, but not always — a group's billing may go to a head office while the
     * patient needs the branch — and one field would force whoever edits it to
     * silently pick which meaning wins.
     */
    publicAddress: text("public_address"),
    /**
     * When the clinic is OPEN — one row per window, per weekday. A weekday with no
     * rows is CLOSED; several rows for one weekday is a split shift, which is the
     * case that decided the shape: a Friday that breaks for Jummah and reopens is
     * normal here, so one start and one end per day would have been wrong.
     *
     * Was free text for a day (migration `0099`) and is structured now (`0101`),
     * because "Mon–Sat 10–8" cannot be grouped, cannot be shown per day, and cannot
     * be checked. Nothing is migrated across: a sentence a human typed is not
     * reliably parseable into windows, and guessing would put words in a clinic's
     * mouth about when it is open.
     *
     * STILL DISPLAY-ONLY. It drives nothing — `checkDoctorSlot` is untouched — and
     * the WhatsApp reply prints these alongside the doctors' own hours so the two can
     * never disagree about when a patient can actually be seen. Validated on the way
     * in by `core/lib/clinic-hours.ts` (conventions §4: jsonb is not an exemption).
     */
    openingHours: jsonb("opening_hours").$type<ClinicHour[]>(),
    // Billing/invoice settings (Finance). `invoicePaper` is the default print size
    // (a4|a5|thermal); `invoicePrefix` prefixes the human invoice label (e.g.
    // "INV-"); `nextInvoiceNo` is the per-clinic counter atomically bumped when an
    // invoice is issued (so concurrent receptionists never collide). See core/billing.
    invoicePaper: vocabularyRef<InvoicePaperCode>(INVOICE_PAPER_ROWS, "invoice_paper")
      .notNull()
      .default("a4")
      .references(() => invoicePapers.id),
    invoicePrefix: text("invoice_prefix").notNull().default("INV-"),
    nextInvoiceNo: integer("next_invoice_no").notNull().default(1),
    // The calendar year `next_invoice_no` currently belongs to. Invoice numbers RESET
    // to 1 each new year → the label is `<prefix><YYYY>-<7-digit>` (e.g. INV-2026-0000005).
    invoiceYear: integer("invoice_year"),
    // Payment-receipt numbering — a per-clinic series distinct from invoices, allocated
    // once per appointment on first money-in (`core/billing/payments.ts`), also RESET per
    // year. Label `<receipt_prefix><YYYY>-<7-digit>` (e.g. RCP-2026-0000012).
    receiptPrefix: text("receipt_prefix").notNull().default("RCP-"),
    nextReceiptNo: integer("next_receipt_no").notNull().default(1),
    receiptYear: integer("receipt_year"),
    // Clinic logo (branding) — an opaque storage key (local FS, per-clinic). Uploaded
    // by the owner/super-admin/account-manager (not the clinic). Printed in B&W at the
    // top of documents; NULL = show nothing. See core/clinics/logo.ts.
    logoKey: text("logo_key"),
    // Patient MRN (Medical Record Number) — a per-clinic, human-friendly patient
    // number formatted as `<mrnPrefix><YYYYMMDD registration><7-digit nextMrn>`, e.g.
    // "KL-202607270000042" (see core/patients/mrn.ts#formatMrn). `nextMrn` is the
    // running counter atomically bumped when a patient is registered (the clinic row
    // is locked, the same collision-free scheme as `nextInvoiceNo`).
    mrnPrefix: text("mrn_prefix").notNull().default("KL-"),
    nextMrn: integer("next_mrn").notNull().default(1),
    // When true, a CLINIC-borne discount needs approval (from a `discount_approval`
    // grantee) before it applies. Per-doctor discounts use users.discountNeedsApproval.
    // See docs/doctor-shares-plan.md §6.
    discountNeedsApproval: boolean("discount_needs_approval").notNull().default(false),
    // Per-clinic WhatsApp SENDER (Meta Cloud API). `whatsappPhoneNumberId` selects
    // which WABA number a message is sent FROM (so patients see the clinic's own
    // number); `whatsappDisplayNumber` (E.164) is for display + inbound routing.
    // NULL = not configured → falls back to the platform sender / graceful no-send.
    // `whatsappSignature` is the clinic-customisable footer fed into the template's
    // {{signature}} variable (no per-clinic Meta approval needed).
    // See docs/whatsapp-cloud-plan.md.
    whatsappPhoneNumberId: text("whatsapp_phone_number_id"),
    whatsappDisplayNumber: text("whatsapp_display_number"),
    whatsappSenderName: text("whatsapp_sender_name"),
    whatsappSignature: text("whatsapp_signature"),
    // ---- Super-admin control plane (docs/super-admin-plan.md §11 Migration A) ----
    // Lifecycle status. `active` = usable; a non-usable status blocks all the clinic's
    // staff from logging in (enforced server-side). Default `active` so existing clinics
    // stay usable; NEW clinics may be created as `trial`.
    status: vocabularyRef<ClinicStatusCode>(CLINIC_STATUS_ROWS, "status")
      .notNull()
      .default("active")
      .references(() => clinicStatuses.id),
    // When the clinic's trial began (set when it first enters `trial`; open-ended until
    // `trial_ends_at`). NULL = never trialled. Distinct from `created_at`.
    trialStartAt: timestamp("trial_start_at", { withTimezone: true }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    // When the clinic became a paying/active tenant (the subscription start). Set on the
    // status → active transition; also the billing-cycle anchor (see core/admin/billing.ts).
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspendReason: text("suspend_reason"),
    // Owner / contact (CRM) + region. `timezone` drives availability/reminders per clinic.
    ownerName: text("owner_name"),
    ownerEmail: text("owner_email"),
    ownerPhone: text("owner_phone"),
    country: text("country"),
    city: text("city"),
    address: text("address"),
    timezone: text("timezone").notNull().default("Asia/Karachi"),
    region: text("region"), // intended data region (compliance)
    // Manual billing (clinic → FlexicaAI). `paid_through` is pushed forward by payments;
    // owed/credit is derived (see core/admin/billing.ts). `capabilities` = the allowed
    // `resource:action` slugs for the whole clinic (NULL = all) — granular super-admin control.
    monthlyPrice: integer("monthly_price").notNull().default(0), // PKR
    billingCycle: vocabularyRef<BillingCycleCode>(BILLING_CYCLE_ROWS, "billing_cycle")
      .notNull()
      .default("monthly")
      .references(() => billingCycles.id),
    graceDays: integer("grace_days").notNull().default(7),
    // How many days BEFORE the paid-through date to surface a "payment coming up"
    // reminder on the admin clinics + overview pages (a soft, pre-due heads-up; distinct
    // from the due/overdue lists). Per-clinic, default 5. See core/admin/billing.ts.
    paymentReminderDays: integer("payment_reminder_days").notNull().default(5),
    // Whether the SOFT payment-due/overdue notice is shown to this clinic's own staff
    // (the workspace pill). Owner / super-admin / the account manager can turn it off
    // for a clinic (e.g. one on a payment plan) without affecting the super-admin dues
    // dashboard or the hard `past_due` access lock. (src/app/clinic/layout.tsx)
    paymentNoticeEnabled: boolean("payment_notice_enabled").notNull().default(true),
    // Follow-up on an OUTSTANDING balance: when a clinic partly pays and commits to
    // pay the rest by a date, we save it here so the super admin knows when to chase.
    // Cleared automatically once the balance settles. (core/admin/billing.ts)
    paymentCommitmentAt: timestamp("payment_commitment_at", { withTimezone: true }),
    paymentCommitmentNote: text("payment_commitment_note"),
    // Health follow-up / snooze: when a super-admin (or the account manager) has
    // actioned a churn-risk / usage-cost alert ("contacted them, they'll be back by
    // X"), we park it here. While `health_followup_at` is in the FUTURE the clinic is
    // suppressed from the at-risk + usage-flag alert lists (moved to "Following up")
    // so it stops nagging; once the date passes it re-surfaces. (core/admin/health.ts)
    healthFollowupAt: timestamp("health_followup_at", { withTimezone: true }),
    healthFollowupNote: text("health_followup_note"),
    capabilities: text("capabilities").array(), // NULL = all resource:action allowed
    // Account manager — the TEAM MEMBER (super-admin) who owns this clinic on our
    // side. NULL = unassigned. Drives "my clinics" + who to update on dues/follow-ups.
    // `AnyPgColumn` return type breaks the clinics⇄users circular type reference.
    assignedTo: uuid("assigned_to").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    notes: text("notes"), // internal CRM notes
    ...softDeleteColumns(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Fast case-insensitive contains-search (ILIKE '%q%') on name via pg_trgm.
    // A plain btree can't serve a leading-wildcard LIKE; a GIN trigram index can.
    index("clinics_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")),
    // Trash listing (super admin): only the trashed rows.
    index("clinics_deleted_idx")
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} is not null`),
    // Inbound WhatsApp routes by the receiving number → clinic. A phone_number_id
    // maps to exactly one clinic (unique when set); it's the routing lookup key.
    uniqueIndex("clinics_wa_phone_id_idx")
      .on(t.whatsappPhoneNumberId)
      .where(sql`${t.whatsappPhoneNumberId} is not null`),
  ],
);

/**
 * Staff accounts. Role + clinicId are the authorization anchors (CLAUDE.md §5).
 * clinicId is NULL for super_admin (company staff belong to no single clinic).
 * Passwords are bcrypt hashes — never store plaintext.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // No FK-level cascade choice yet for super_admin (null); set null on clinic delete.
    clinicId: uuid("clinic_id").references(() => clinics.id, {
      onDelete: "set null",
    }),
    // Login identifier — a short handle like "admin" (not an email).
    username: text("username").notNull(),
    // Optional contact email (for future notifications / password reset).
    email: text("email"),
    passwordHash: text("password_hash").notNull(),
    role: vocabularyRef<UserRoleCode>(USER_ROLE_ROWS, "role")
      .notNull()
      .references(() => userRoles.id),
    // Optional name prefix/title (e.g. Dr, Mr, Miss) — shown as "Dr. Bilal Aziz"
    // in the UI and patient messages. Free text from a fixed dropdown.
    prefix: text("prefix"),
    fullName: text("full_name"),
    // Storage key of the user's profile picture (core/integrations/storage), or
    // NULL. Served (self-only) via GET /api/me/avatar.
    avatarKey: text("avatar_key"),
    isActive: boolean("is_active").notNull().default(true),
    // Distinguishes the two inactive states for team members (both have
    // is_active=false): NULL = SUSPENDED (temporary, keeps their clinic
    // assignments); set = DEACTIVATED (their clinics were unassigned). Reactivating
    // clears it. (core/auth/admin-permissions.ts adminAccountState)
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    // Set true when an admin creates the account with a temporary password;
    // cleared once the user sets their own (forced on first login).
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    // Per-user permission slugs ("resource:action"). NULL = fall back to the
    // role's defaults (see core/auth/permissions.ts); a non-null array is an
    // admin override that fully replaces those defaults. Free-text (not enums)
    // so the catalog can grow without a schema change.
    permissions: text("permissions").array(),
    // UI theme preference; "system" follows the OS.
    theme: vocabularyRef<ThemePreferenceCode>(THEME_PREFERENCE_ROWS, "theme")
      .notNull()
      .default("system")
      .references(() => themePreferences.id),
    // Doctor scheduling (specialty-agnostic, core/lib/availability.ts). Empty for
    // non-doctors and for doctors with no restriction. `availability` is the
    // per-weekday working windows; `dailyAppointmentLimit` caps bookings per day
    // (0 = unlimited). Both only meaningful for role = doctor.
    availability: jsonb("availability")
      .$type<DayAvailability[]>()
      .notNull()
      .default([]),
    // When true, the doctor can be booked at ANY time — the working-hours in
    // `availability` are not enforced (leave and the daily cap still apply). When
    // false, appointments may only be made during those visiting hours.
    flexibleHours: boolean("flexible_hours").notNull().default(false),
    dailyAppointmentLimit: integer("daily_appointment_limit")
      .notNull()
      .default(0),
    // Doctor's consultation fee in whole PKR (0 = not set). Per-doctor.
    consultationFee: integer("consultation_fee").notNull().default(0),
    // Doctor revenue share (percent 0-100) the clinic pays the doctor. `consultation`
    // = cut of the consultation fee; `procedure` = DEFAULT cut of procedures (a
    // per-procedure override in `doctor_procedure_shares` wins). See
    // docs/doctor-shares-plan.md.
    consultationSharePct: integer("consultation_share_pct").notNull().default(0),
    procedureSharePct: integer("procedure_share_pct").notNull().default(0),
    // When true, a discount taken from THIS doctor's share needs their approval
    // before it applies (the doctor's own policy; editable by them and the admin).
    discountNeedsApproval: boolean("discount_needs_approval").notNull().default(false),
    // ---- 2FA / TOTP (super-admin panel security; usable by any account) ----
    // `totpSecret` = base32 shared secret (present once enrolled); `totpEnabled` gates
    // the login TOTP challenge + step-up; `totpBackup` = SHA-256 hashes of one-time
    // backup codes. See core/auth/totp.ts + docs/super-admin-plan.md §11 Feature 1.
    totpSecret: text("totp_secret"),
    totpEnabled: boolean("totp_enabled").notNull().default(false),
    totpBackup: text("totp_backup").array(),
    ...softDeleteColumns(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Username is the login credential — globally unique, stored lowercased.
    // PARTIAL: a trashed user keeps its row, so uniqueness ignores deleted rows —
    // otherwise the username/email could never be reused after a soft delete.
    uniqueIndex("users_username_unique")
      .on(table.username)
      .where(sql`${table.deletedAt} is null`),
    // Email is optional; unique when present (Postgres treats NULLs as distinct).
    uniqueIndex("users_email_unique")
      .on(table.email)
      .where(sql`${table.deletedAt} is null`),
    // Multi-tenant lookups filter by clinic_id constantly — index it.
    index("users_clinic_id_idx").on(table.clinicId),
    // Trash listing per clinic: only trashed staff.
    index("users_deleted_idx")
      .on(table.clinicId, table.deletedAt)
      .where(sql`${table.deletedAt} is not null`),
  ],
);

/**
 * Server-side sessions. The browser holds only an opaque random token in an
 * HTTP-only cookie; we store its SHA-256 hash here (so a DB leak can't be used
 * to impersonate users). Validated per request in Node (not in the Edge proxy).
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Super-admin support impersonation: when set, this session ACTS AS that clinic
    // (Feature 5). Never set for clinic staff. See docs/super-admin-plan.md §11.
    impersonatedClinicId: uuid("impersonated_clinic_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

/**
 * `password_reset_tokens` — self-service password reset. Follows the `sessions` pattern
 * (keyed by user; no clinic_id, not soft-deleted): store the SHA-256 of an opaque token,
 * single-use (`used_at`), short expiry. Consuming one revokes the user's sessions.
 * See `core/auth/password-reset.ts`.
 */
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("password_reset_tokens_hash_unique").on(table.tokenHash),
    index("password_reset_tokens_user_idx").on(table.userId),
  ],
);

/**
 * Patients — shared across all specialties (CLAUDE.md §5). One patient may use
 * multiple modules at the same clinic. `phone` is the WhatsApp number (primary
 * contact channel for recalls). Specialty clinical data never lives here.
 */
export const patients = pgTable(
  "patients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    // Per-clinic Medical Record Number — a human-friendly patient number allocated
    // sequentially on registration (see core/patients/mrn.ts) and shown with the
    // clinic's `mrnPrefix`. Nullable only so the column can be added + backfilled;
    // every live patient has one. Unique per clinic (index below).
    mrn: integer("mrn"),
    fullName: text("full_name").notNull(),
    // E.164 WhatsApp number (e.g. +9230…). Primary contact for reminders.
    phone: text("phone"),
    email: text("email"),
    dateOfBirth: date("date_of_birth"),
    gender: text("gender"),
    address: text("address"),
    notes: text("notes"),
    // How the patient was referred (free text) — e.g. "Dr. Khan", "Instagram",
    // another patient's name. Optional; for referral tracking.
    reference: text("reference"),
    // The clinic's OLD-system patient number, captured at data import so the front
    // desk can still search by it (kept distinct from `reference` = how referred).
    // See docs/import-plan.md.
    externalRef: text("external_ref"),
    // Pre-FlexicaAI dues carried in at import (whole PKR, ≥ 0). Added to the patient's
    // outstanding in receivables + the statement; settled by an `opening` payment
    // (patient_payments.kind = 'opening'). NULL/0 = none.
    openingBalance: integer("opening_balance").notNull().default(0),
    // The import batch this row came from (NULL = registered in-app). Enables a
    // one-click "undo import" (soft-delete the whole batch). No FK — batches are a
    // company-side record.
    importBatchId: uuid("import_batch_id"),
    // Consent for data use (CLAUDE.md §10). Photo consent added by modules that need it.
    dataConsent: boolean("data_consent").notNull().default(false),
    // Consent to take/store clinical PHOTOS (gates `is_photo` attachments — §10).
    // Separate from data_consent; a photo can't be uploaded/shown without it.
    photoConsent: boolean("photo_consent").notNull().default(false),
    ...softDeleteColumns(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("patients_clinic_id_idx").on(t.clinicId),
    // MRN is unique per clinic and this is the exact-lookup index for "open the
    // patient by MRN" (partial: only rows that have a number).
    uniqueIndex("patients_clinic_mrn_idx")
      .on(t.clinicId, t.mrn)
      .where(sql`${t.mrn} is not null`),
    // Lookup by the clinic's old patient number (only rows that carry one).
    index("patients_clinic_external_ref_idx")
      .on(t.clinicId, t.externalRef)
      .where(sql`${t.externalRef} is not null`),
    // Tenant-scoped lookups by phone / name are common in reception search.
    index("patients_clinic_phone_idx").on(t.clinicId, t.phone),
    index("patients_clinic_name_idx").on(t.clinicId, t.fullName),
    // Fast ILIKE '%q%' contains-search on name and phone (pg_trgm GIN).
    index("patients_name_trgm_idx").using("gin", t.fullName.op("gin_trgm_ops")),
    index("patients_phone_trgm_idx").using("gin", t.phone.op("gin_trgm_ops")),
    // Trash listing per clinic: only trashed patients.
    index("patients_deleted_idx")
      .on(t.clinicId, t.deletedAt)
      .where(sql`${t.deletedAt} is not null`),
  ],
);

// Inferred row types for use across the app.
export type Clinic = typeof clinics.$inferSelect;

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;

export type User = typeof users.$inferSelect;

export type Session = typeof sessions.$inferSelect;

export type Patient = typeof patients.$inferSelect;
