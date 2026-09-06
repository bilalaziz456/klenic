# Database schema — FlexicaAI

> **Source of truth is `src/core/db/schema/`** (Drizzle) — split by domain behind a
> barrel, so `import { … } from "@/core/db/schema"` still reaches everything:
> `identity` (clinics, users, sessions, patients) · `scheduling` · `clinical` ·
> `billing` · `messaging` · `platform` · `_shared` (the soft-delete columns).
> The boundaries follow the FOREIGN KEYS — the files must form a DAG, since a cycle
> between two schema modules breaks at import time (delta D-09; see `schema/index.ts`).
> Migrations are generated from it (`npm run db:generate`) into `/drizzle`. Never
> hand-edit the database — change the schema and generate a migration. This document
> is the human-readable reference; if the two disagree, the schema wins.
>
> Imported by root `CLAUDE.md` §5.

---

## 1. Principles (always true)

**Design every table to support multiple specialties from day one.**

- **Core, specialty-agnostic.** Only shared platform tables live in `schema.ts`.
  Core never hardcodes a specialty; the `module` column is a free-text tag (NOT an
  enum) so adding derma/hair needs no schema change.
- **Specialty data goes in related tables, not core.** Dental-specific data (e.g.
  tooth-chart state) belongs in a `dental_records` table linked to `visits`, never
  as columns on core tables. When derma is added, `derma_records` is a new table;
  core tables never change.
- **Multi-tenancy:** every tenant table has `clinic_id`, and **every query filters
  by `clinic_id`** — enforced in the server-side query layer via the `byClinic()`
  helper (`src/core/db/tenant.ts`). The browser never touches the DB; all access is
  through Server Actions / Route Handlers. Native Postgres RLS is a possible future
  defense-in-depth; for now the query layer is the boundary.
- **Timestamps:** all `created_at` / `updated_at` are `timestamptz` defaulting to
  `now()`. All ids are `uuid` default random.
- **Soft delete (NOTHING is hard-deleted).** Every deletable table carries four
  columns (spread from `softDeleteColumns()` in `schema.ts`): `deleted_at`
  timestamptz (NULL = live; the source of truth), `deleted_by` uuid (who trashed
  it; no FK — users are themselves soft-deleted), `delete_group` uuid (one id
  shared by a parent and the children its deletion cascade-hid → Restore reverts
  exactly that batch), `deleted_by_cascade` bool (true = hidden only because a
  parent was trashed; the Trash list shows only the non-cascade rows). Tables with
  soft delete: `clinics`, `users`, `patients`, `appointments`, `visits`, `recalls`,
  `procedures`, `doctor_leaves`, `expenses`, `patient_payments`, `invoices`,
  `clinic_payments`, `company_expenses`, `clinic_invoices` (the last three are
  managed in their own ledgers, not the central Trash UI). The
  central Trash UI (`core/trash`, `/clinic/trash` + `/admin/trash`) currently lists +
  restores `clinics`/`users`/`patients`/`appointments`/`visits`/`recalls`/`procedures`/
  `expenses`/`doctor_leaves` (payments/invoices soft-delete but are managed in their
  own ledgers, not the Trash UI). **Every normal read must filter `deleted_at IS
  NULL`.** A trashed record leaves the clinic-level Trash after
  `clinics.trash_retention_days` (default 30, super-admin-set) but stays in the DB
  and visible to the super admin forever; the ONLY physical delete is a super-admin
  legal purge. `users.username` / `email` uniqueness is PARTIAL (`WHERE deleted_at
  IS NULL`) so a name frees up after a soft delete. Each table has a partial trash
  index on (`clinic_id`,`deleted_at`) `WHERE deleted_at IS NOT NULL`.
  (Migration `0027`.)

---

## 2. Vocabularies

**There are no Postgres enums.** Every closed vocabulary is a REFERENCE TABLE and the
column carrying it is an `integer` foreign key (ADR-027, migrations `0087`–`0092`).
Twenty-eight tables covering thirty-six columns, all `(id, code, label, sort_order,
is_active)`, company-global — no
`clinic_id`, so the tenant guard ignores them and a clinic cannot invent its own.

| Table | Codes | Column(s) it backs |
|---|---|---|
| `appointment_statuses` | scheduled, confirmed, arrived, in_progress, completed, cancelled, no_show | `appointments.status` |
| `visit_statuses` | transcribing, draft, approved, failed | `visits.status` |
| `recall_statuses` | pending, scheduled, sent, booked, completed, cancelled | `recalls.status` |
| `user_roles` | super_admin, clinic_admin, manager, doctor, receptionist | `users.role` |
| `theme_preferences` | system, light, dark | `users.theme` |
| `whatsapp_directions` | inbound, outbound | `whatsapp_messages.direction` |
| `whatsapp_statuses` | queued, sent, delivered, read, failed, received | `whatsapp_messages.status` |
| `chat_intents` | book, reschedule, cancel, price, clinical, other, fee, hours, **location** | `whatsapp_messages.intent` |
| `payment_kinds` | payment, advance, advance_applied, refund, opening | `patient_payments.kind` |
| `clinic_payment_kinds` | payment, refund, credit | `clinic_payments.kind` |
| `payment_methods` | cash, bank, cheque, other, **advance** (`is_tender = false`) | the five `method` columns |
| `settlement_kinds` | doctor_waive, clinic_waive, repayment, write_off, reversal | `doctor_settlement_actions.kind` |
| `settlement_parties` | clinic, doctor | `discount_settlements.party`, `appointment_discount_approvals.approver_kind` |
| `approval_statuses` | pending, approved, rejected | `appointment_discount_approvals.status` |
| `discount_statuses` | none, pending, approved, rejected | `appointments.discount_status` |
| `discount_types` | amount, percent | the three `discount_type` / `discount_split_type` columns |
| `discount_bearers` | clinic, doctor, split | `appointments.discount_borne_by` |
| `clinic_statuses` | trial, active, suspended, past_due, cancelled | `clinics.status` |
| `billing_cycles` | monthly, 2m, quarter, half, annual | `clinics.billing_cycle` |
| `invoice_papers` | thermal, a5, a4 | `clinics.invoice_paper` (the default) + `clinics.invoice_papers_enabled` (which are offered) |
| `treatment_plan_statuses` | proposed, active, completed, cancelled | `treatment_plans.status` |
| `treatment_item_statuses` | planned, in_progress, done, cancelled | `treatment_plan_items.status` |
| `attachment_kinds` | xray, photo, document, consent | `clinical_attachments.kind` |
| `import_batch_statuses` | active, undone | `import_batches.status` |
| `announcement_levels` | info, warning | `announcements.level` |
| `ai_providers` | whisper, claude | `ai_usage.provider` (NOT `.model`) |
| `tax_modes` | itemized, total | `platform_cost_rates.tax_mode` |
| `recurrences` | monthly, weekly | `expenses.recurrence`, `company_expenses.recurrence` |
| `appointment_sources` | staff, whatsapp | `appointments.source` |

**Three things to know before touching these.**

**The application still reads and writes CODES.** `core/db/schema/vocabulary.ts#vocabularyRef`
is a Drizzle `customType` storing the integer and presenting the code, so
`eq(appointments.status, "completed")` compiles and emits `status = 5`. Raw SQL is the
exception: it compares against `appointmentStatusId("completed")`, and a `pool.query`
in a test gets the integer back — join the lookup to read a code.

**Ids are written out, never assigned by a sequence** (`src/core/db/vocabulary-seed.ts`).
A `serial` assigns by insertion order, so a re-seed in a different order would silently
reclassify data already recorded. Never renumber; never reuse a retired id — set
`is_active = false` so historical rows still resolve.
`scripts/test-vocabulary-tables.ts` asserts the database matches the constants row for row.

**The database owns PRESENTATION; the code owns MEANING.** `core/db/vocabulary-cache.ts`
loads the label, sort order and active flag from the database and re-reads them on a
60-second TTL, so renaming a status or reordering a dropdown really is just a row
update — no deploy and no restart. Server components read that cache; client components
get it through `core/ui/vocabulary-provider.tsx`, which the root layout supplies. There
are no compiled label maps left. But `nextQueueAction` switches on a status and
`can()` on a role — a row inserted into the database alone is stored and never acted on,
so a NEW value is still a code change.

**Open vocabularies stay open** and must not be given a table: `module` above all (a
table of specialties would put a specialty name in core and break ADR-001), plus
`activity_logs.action`/`entity`, `notifications.type`, `imported_transactions.type` and
`.method`, and `ai_usage.model`. `activity_logs.actor_role` stays TEXT for a different
reason — it is a snapshot, like `sales.doctor_name`, and must survive the role
vocabulary changing.

---

## 3. Tables

### `clinics` — tenants
`id`, `name`, `modules_enabled` text[] (e.g. `{dental}`; specialty checkboxes
read/write this), `features_enabled` text[] (super-admin-toggled optional features,
e.g. `{revenue_dashboard}` — see `core/lib/features.ts`), `log_access` text[]
(activity-log action categories the clinic admin may see, e.g. `{login,update}`;
empty = no log access — see `core/audit/access.ts`), `avg_visit_value` int
(PKR, default 3000; drives "Revenue Recovered"), `trash_retention_days` int
(default 30; §1 soft-delete). **Per-clinic WhatsApp sender (Meta Cloud API — see
`docs/whatsapp-cloud-plan.md`):** `whatsapp_phone_number_id` (selects the sending
number; **unique when set** — the inbound routing key), `whatsapp_display_number`
(E.164), `whatsapp_sender_name`, `whatsapp_signature` (clinic-customisable footer
for the template's {{signature}} var). All NULL = not configured → platform sender /
graceful no-send. Timestamps + soft-delete columns.
Indexes: GIN pg_trgm on `name` (fast ILIKE search); partial unique on
`whatsapp_phone_number_id`; partial trash index on `deleted_at`.

### `users` — staff accounts
`id`, `clinic_id` → clinics (**nullable**; NULL for super_admin; `on delete set
null`), `username` (**unique**, lowercased), `email` (**unique when present**),
`password_hash` (bcrypt), `role` (→ `user_roles`), `prefix` (name title — Dr/Mr/Miss…, shown
as "Dr. Bilal Aziz"), `full_name`, `avatar_key` (profile-picture storage key, served
self-only via `GET /api/me/avatar`), `is_active` (default true),
`must_change_password` (default false), `theme` (→ `theme_preferences`). **Doctor-only fields:**
`availability` jsonb `DayAvailability[]` (per-weekday working windows — a weekday
may appear multiple times for split shifts, e.g. Mon 09:00–12:00 AND 16:00–19:00), 
`flexible_hours` bool (default false; true = bookable any time, hours not enforced —
leave + cap still apply), `daily_appointment_limit` int (0 = unlimited),
`consultation_fee` int (PKR, 0 = not set). **`permissions`** text[] (nullable) —
per-user `resource:action` grant slugs; NULL = fall back to the role's defaults,
a non-null array fully replaces them (see `core/auth/permissions.ts`; two-tier
access = clinic capability ∩ this). Timestamps.
Indexes: unique `username`, unique `email`, `clinic_id`.

### `sessions` — server-side sessions
`id`, `user_id` → users (`on delete cascade`), `token_hash` (**unique**; SHA-256 of
the opaque cookie token), `expires_at`, `created_at`. Validated per request in Node
(not the Edge proxy). Indexes: unique `token_hash`, `user_id`, `expires_at`.

### `patients` — shared across specialties
`id`, `clinic_id` → clinics (`cascade`), `full_name`, `phone` (WhatsApp number,
primary contact), `email`, `date_of_birth`, `gender`, `address`, `notes`,
`reference` (free text — how the patient was referred, e.g. a doctor/patient/ad),
`data_consent` (default false), timestamps. Note: `date_of_birth` is still the
stored source of truth, but the UI enters/shows it as **age** (derived — see
`core/lib/age.ts`), so age never goes stale.
Indexes: `clinic_id`; (`clinic_id`,`phone`); (`clinic_id`,`full_name`); GIN pg_trgm
on `full_name` and `phone`.

### `appointments` — shared
`id`, `clinic_id` → clinics (`cascade`), `patient_id` → patients (`cascade`),
`doctor_id` → users (`set null`), `module` (free-text tag), `scheduled_at`,
`duration_minutes` (default 30), `status` (→ `appointment_statuses`, default scheduled), `reason`,
`discount_type` (free-text, default 'amount'; 'amount' = flat PKR, 'percent' = % of
the doctor's fee), `discount_value` int (default 0; the raw figure — e.g. 500, or 20
for 20%; **CHECK: a 'percent' value must be 0–100** — unbounded, it overflowed int4
inside the bill SQL and made Postgres throw where TS clamped, see ADR-021/D-17. A
flat amount has no ceiling; the bill clamps it), `discount_borne_by` (free-text, default 'clinic'; 'clinic'|'doctor'|'split'
— who absorbs the discount in the doctor/clinic split), `discount_status` (free-text,
default 'none'; 'none'|'pending'|'approved'|'rejected' — a 'pending'/'rejected'
discount is treated as 0 in the bill/sale/split until approved, derived from
`appointment_discount_approvals`, see `core/appointments/approvals.ts`),
`charge_consultation` bool (default true; **false = procedure-only visit**,
the doctor's consultation fee is not billed — the bill/sale count only procedures),
`source` (free-text, default 'staff'; 'whatsapp' = patient self-booked →
stays a request until staff confirm), `reminder_sent_at` (set once the day-before
reminder is sent; NULL = not reminded), `queue_session` (text, NULL when no doctor;
groups a doctor's appointments for one visiting WINDOW on a day —
`${doctorId}:${YYYY-MM-DD}:w{idx}`, or `:day` for flexible/no-window), `queue_number`
(int, NULL when no doctor; FCFS patient token within that session, assigned at
booking, stable across cancellations), timestamps. The net fee (doctor's
`consultation_fee` − discount) is derived live via `core/appointments/fee.ts`, never
stored, so a fee change flows through. Queue logic: `core/appointments/queue.ts`.
Indexes: `clinic_id`; `patient_id`; (`clinic_id`,`scheduled_at`); `doctor_id`;
(`scheduled_at`,`reminder_sent_at`) for the reminder cron; UNIQUE
(`clinic_id`,`queue_session`,`queue_number`) — token uniqueness + assignment lookup
(NULLs distinct, so un-queued rows never collide).

### `visits` — shared; stores the AI note
`id`, `clinic_id` (`cascade`), `patient_id` (`cascade`), `appointment_id` → appts
(`set null`), `doctor_id` → users (`set null`), `module`, `status` (→ `visit_statuses`, default
draft — **AI notes are draft until a doctor approves**), `transcript` (raw Whisper),
`note` jsonb (module-shaped, doctor's approved version), `ai_draft` jsonb (frozen
original for the accuracy flywheel), `audio_key` (storage key), `visit_date`,
`approved_at`, `approved_by` → users (`set null`), timestamps.
Indexes: `clinic_id`; `patient_id`; (`clinic_id`,`visit_date`); `appointment_id`.

### `recalls` — recall engine reads/advances these
`id`, `clinic_id` (`cascade`), `patient_id` (`cascade`), `source_visit_id` → visits
(`set null`), `module`, `reason` (e.g. "6-month cleaning"), `due_at`, `status`
(→ `recall_statuses`, default pending), `sent_at`, timestamps.
Indexes: `clinic_id`; `patient_id`; (`clinic_id`,`due_at`); `status`.

### `whatsapp_messages` — inbound + outbound log
`id`, `clinic_id` → clinics (`cascade`, **nullable**), `patient_id` → patients (`set
null`, **nullable** — an unknown inbound number may be unattributed), `direction`
(→ `whatsapp_directions`), `phone`, `status` (→ `whatsapp_statuses`, default queued), `template_name` (AiSensy
campaign), `body` (preview text), `media_url`, `external_id` (provider id for
receipts), `error`, `payload` jsonb (raw), timestamps. Every send is recorded first
so nothing is lost when the provider is unconfigured; also the source for the
receptionist WhatsApp queue and inbound reschedule. Inbound rows are written by ONE
pipeline (`core/integrations/whatsapp/inbound.ts`) shared by both provider webhooks;
only the sender-resolution differs, because AiSensy has a single number for every
clinic (cross-tenant lookup, `unscoped`) while the Cloud API gives each clinic its
own (scoped to the routed clinic).
Indexes: `clinic_id`; `patient_id`; `phone`; (`clinic_id`,`created_at`);
`external_id`.

### `doctor_leaves` — leave / vacation
`id`, `clinic_id` → clinics (`cascade`), `doctor_id` → users (`cascade`),
`start_date` date, `end_date` date (inclusive; single day sets both equal),
`reason`, `created_at`. Set by receptionist/clinic admin; creating a leave cancels
the doctor's appointments in range and blocks new bookings on those days.
Indexes: `clinic_id`; (`doctor_id`,`start_date`,`end_date`) for the booking guard.

### `activity_logs` — audit / activity trail
`id`, `clinic_id` → clinics (`cascade`, **nullable** — NULL for pure super-admin
actions), `actor_user_id` → users (`set null`, **nullable**), `actor_name`
(snapshot, so the row survives the user being renamed/deleted), `actor_role`
(snapshot), `action` (free-text: create/update/delete/login/view/status),
`entity` (patient/appointment/staff/clinic/settings/session/leave), `entity_id`
(uuid, nullable), `summary` (human line), `metadata` jsonb, `created_at`. Records
**all clinic-staff actions + logins + record views**, plus **patient WhatsApp
self-service** (`core/audit/log.ts#logPatientAction`) — a booking, reschedule or
cancellation the patient made themselves. Those rows carry `actor_user_id` NULL and
`actor_role = 'patient'`, which is legitimate precisely because that column is a text
SNAPSHOT rather than an FK into `user_roles`; the patient is identified by id in
`metadata`, never by name in `actor_name` (§10). Access is PERMISSION-based
(not time-based): the super admin grants each clinic a set of visible ACTION
categories via `clinics.log_access` (see `core/audit/access.ts`, which holds TWO
role lists on purpose: `CLINIC_LOG_STAFF_ROLES` populates the employee picker, which
lists people, while `CLINIC_LOG_ROLES` adds `patient` and filters rows); the clinic admin
(`/clinic/logs`) sees only those categories for their own clinic, and no log page
at all when `log_access` is empty. The super admin (`/admin/logs`) always sees
everything across clinics. Both pages default to TODAY with date-range + employee
filters (+ clinic filter for the super admin). Written via best-effort
`logActivity`/`logActivityAs` (never throws/blocks); views come from a client
`ViewLogger` (avoids prefetch phantom logs). A view is written by ONE statement
(`INSERT … SELECT … WHERE NOT EXISTS`) that both de-duplicates within
`VIEW_DEDUPE_MINUTES` and inserts — see ADR-023, and note the `IS NOT DISTINCT FROM`
trap recorded there before touching it. **Retention:** append-only under ADR-006, so
`company_settings.activity_log_retention_days` bounds it (0 = keep everything, the
default; 90-day floor on anything set), pruned nightly by `GET /api/cron/log-retention`
— the only hard delete in the audit path.
Indexes: (`clinic_id`,`created_at`); (`created_at`); `actor_user_id`; partial
(`actor_user_id`,`entity`,`entity_id`,`created_at` desc) `WHERE action = 'view'` — the
dedupe lookup, which runs on every record open and was previously unindexed
(migration `0081`).

### `procedures` — priced services (Sales feature, phase 1)
`id`, `clinic_id` → clinics (`cascade`), `name`, `price` int (whole PKR),
`module` (free-text specialty tag), `is_active` bool (default true; inactive =
hidden from booking, kept for history), timestamps. CORE + specialty-agnostic —
each clinic manages its own list; the specialty MODULE only supplies suggested
defaults (`ModuleDefinition.procedureTemplates`, imported via
`config/modules.ts#procedureTemplatesFor`). CRUD by clinic admin OR receptionist
(`app/reception/procedure-actions.ts`), audit-logged, gated by the `sales`
feature (`core/lib/features.ts`). Indexes: `clinic_id`; (`clinic_id`,`is_active`).

### `appointment_procedures` — appointment line items (Sales feature, phase 2)
`id`, `clinic_id` → clinics (`cascade`), `appointment_id` → appointments
(`cascade`), `procedure_id` → procedures (`set null`), `name` + `unit_price`
(**snapshots** — catalog edits never rewrite past appointments), `quantity`
(user-set in the booking form, ≥ 1), `discount_type` (free-text, default 'amount')
+ `discount_value` int (default 0) — an **optional per-line discount** applied to
THIS line's gross (`unit_price×quantity`) BEFORE the appointment-level discount —
and `created_at`. The bill is **layered**: each line is discounted first (`lineNet
= gross − line discount`), summed with the consultation fee into a **subtotal**,
then the appointment's own discount applies to that subtotal. ONE formula does this
(ADR-015): `core/appointments/fee.ts#billFromTotals`, with `computeBill` (from lines)
and `computeSaleAmounts` (for the ledger snapshot) as projections of it. To keep the
many callers a single fast aggregate (not N queries), the same formula is expressed in
SQL by `procedures.ts#procedureRowNetSql` (per line) and
`bill-sql.ts#appointmentNetSql` (per appointment) — bound to the TS by
`scripts/test-bill-parity.ts`, which asserts they agree to the rupee, so the two can
no longer drift.

**How those inputs are OBTAINED is a parameter (ADR-030).** `appointmentProceduresNetSql`
/ `appointmentProceduresGrossSql` are correlated — right for one appointment or one page
— while **`procedureTotals(clinicId)` pre-aggregates the lines for a whole clinic in a
single pass** and is LEFT JOINed instead by anything aggregating or filtering across
many appointments (dashboard KPIs, receivables, the invoice register, the discounts
report, the nightly reconcile). The bill names its subtotal three times and Postgres
re-executes a scalar subquery for each mention, so the correlated form cost 279 subplan
executions over 134 rows on the dashboard, and nine sub-SELECTs per row in the
receivables report — one of them in a non-sargable WHERE. Same formula either way; the
parity test asserts the two agree, including on appointments with no lines at all. The
correlated `appointmentProceduresNetSql` / `appointmentProceduresGrossSql` helpers
used by both appointment lists, the WhatsApp confirmation + reschedule quote, the
sales ledger, and the report's per-procedure breakdown. Saved on create/edit via
`saveAppointmentProcedures` (replace-all, `{procedureId, quantity, discountType,
discountValue}[]`, clinic-scoped); `getAppointmentProcedureItems` reads the snapshots
back for the edit-form prefill and the read-only bill. Indexes: `appointment_id`;
`clinic_id`; `procedure_id`.

### `sales` — realised-revenue ledger (Sales feature, phase 3)
`id`, `clinic_id` → clinics (`cascade`), `appointment_id` → appointments
(`cascade`, **UNIQUE** — one sale per appointment), `doctor_id` → users (`set
null`), `doctor_name` (**snapshot**, survives the doctor being renamed/deleted),
`gross_amount` / `discount_amount` / `net_amount` (int PKR, **snapshots** computed
via `computeSaleAmounts` = fee + procedures − discount; `gross` is the TRUE
pre-discount figure, so `gross − discount = net` always holds), `occurred_at`
(= the appointment's `scheduled_at`; drives the report's time buckets),
`created_at`. One row per **completed** appointment, written by
`core/sales/ledger.ts`: `recordSaleForAppointment` (upsert on the completion hook
in `setAppointmentStatus`, and re-snapshot when a completed appointment is edited),
`voidSaleForAppointment` (delete when it leaves "completed"),
`backfillClinicSales` (idempotent; run when the super admin first enables the
`sales` feature, in `admin/actions.ts#updateClinic`). The sale and its sibling derived
ledgers are written in ONE transaction, joined to the completion event so they cannot
disagree with the appointment (ADR-016); on the payment path the write stays
best-effort so a ledger hiccup never blocks taking money, and the nightly
`reconcile` cron (`core/sales/reconcile.ts`) re-derives any drift. The report (`core/sales/report.ts`,
`/clinic/sales`) reads this table: summary, per-doctor + per-procedure breakdown,
and a bucketed net-sales-over-time chart, filterable by period / custom range /
doctor. Gated by the `sales` feature; clinic-scoped. Indexes: UNIQUE
`appointment_id`; (`clinic_id`,`occurred_at`) for the range scan; `doctor_id`.

### `sale_shares` — per-doctor share ledger (revenue-share, phase 4)
`id`, `clinic_id` → clinics (`cascade`), `appointment_id` → appointments
(`cascade`), `doctor_id` → users (`set null`), `doctor_name` (**snapshot**),
`share_amount` int (PKR), `occurred_at` (= the appointment's `scheduled_at`),
`created_at`. One row per DOCTOR who earned a positive
share on a **completed** appointment — the CLINIC's cut is derived (sale net − Σ
these rows), so there is no clinic row. Snapshotted at completion via
`core/appointments/shares.ts#computeShare` on the **approval-gated** net, so later
rate/discount edits never rewrite history. Written by `core/sales/share-ledger.ts`,
folded into `recordSaleForAppointment` / `voidSaleForAppointment` /
`backfillClinicSales` so it stays in lockstep with the `sales` ledger (recording
REPLACES all rows for the appointment; a multi-doctor visit yields several).
**Inert** when no doctor has a share % (no rows). Earnings and payments are an
AMOUNT-based running balance (Phase 7 — no per-share paid flag). Indexes:
(`appointment_id`); (`clinic_id`,`occurred_at`); (`clinic_id`,`doctor_id`).

### `doctor_payouts` — doctor payments (revenue-share, phase 6-7)
`id`, `clinic_id` → clinics (`cascade`), `doctor_id` → users (`set null`),
`doctor_name` (**snapshot**), `amount` int (PKR), `method` (free-text —
cash/bank/cheque/other), `reference` (txn/cheque no.), `period_start` /
`period_end` date (optional; a period the payment covers), `note`, `created_by`
uuid (no FK) + `created_by_name` snapshot, `created_at`. One row per PAYMENT: an
AMOUNT-based running balance (Phase 7) — Earned = Σ `sale_shares.share_amount`
(lifetime), Paid = Σ these `amount`s, Outstanding = the difference. A payment is an
**arbitrary amount** (partial allowed), validated `0 < amount ≤ outstanding` by
`core/sales/payouts.ts#recordPayout`; `voidPayout` deletes the row → the balance
rises again. Clinic admin records/reverses from `/clinic/shares` (scoped to a
doctor) + prints a statement (`/clinic/shares/statement`); a doctor sees their own
read-only. Indexes: (`clinic_id`,`doctor_id`); (`clinic_id`,`created_at`).

### `discount_settlements` — doctor↔clinic discount bearing (discount-bearing, phase 1)
`id`, `clinic_id` → clinics (`cascade`), `appointment_id` → appointments (`cascade`),
`party` ('clinic' | 'doctor'), `doctor_id` → users (`set null`; NULL for the clinic
row), `doctor_name` (**snapshot**), `gross_share` int (party's pre-discount cut,
reference), `settlement_amount` int (**signed** balance adjustment; − = the party
bears a loss / a doctor may go into deficit), `occurred_at` (= scheduled_at),
`created_at`. One snapshot row per PARTY per completed appointment carrying an
effective discount. Captures the approved policy — whoever bears a discount absorbs it
fully (no spillover), computed as a **zero-sum transfer** on the NET bill + gross
shares (collection-independent), so Σ settlement = 0 and totals converge to make-whole
as the patient pays. Pure math in `core/appointments/discount-bearing.ts#computeBearing`;
written replace-all-per-appointment on the completion/edit/approval hooks (like
`sale_shares`). See `docs/discount-bearing-plan.md` §3. Indexes: (`appointment_id`);
(`clinic_id`,`occurred_at`); (`clinic_id`,`doctor_id`).

### `doctor_settlement_actions` — waives / repayments / write-offs (discount-bearing, phase 1)
`id`, `clinic_id` → clinics (`cascade`), `doctor_id` → users (`set null`),
`doctor_name` (**snapshot**), `appointment_id` → appointments (`set null`; NULL for a
standalone repayment/write-off), `line_ref` (procedure id | 'consultation' | NULL =
whole visit), `kind` ('doctor_waive' | 'clinic_waive' | 'repayment' | 'write_off' |
'reversal'), `amount` int (positive PKR; effect from `kind`), `reverses_id` (self-ref,
no FK — the row a reversal undoes), `note`, `created_by(+name)` snapshot, `occurred_at`,
`created_at`. The manual money moves on a doctor's share balance: a doctor forgoes his
own share (`doctor_waive`, by self-identity), the clinic forgives a deficit
(`clinic_waive`, a clinic cost) / records a doctor→clinic `repayment` / `write_off`, or
reverses any (`reversal`). Clinic-side kinds need the **`share_waive`** permission.
Indexes: (`clinic_id`,`doctor_id`); (`clinic_id`,`occurred_at`); (`appointment_id`);
**partial UNIQUE** (`appointment_id`,`line_ref`) `WHERE kind='doctor_waive' AND line_ref
IS NOT NULL AND appointment_id IS NOT NULL` — at most one per-line waive per line, so a
double-waive race can't create duplicates (migration `0042`).

### `patient_payments` — money in/out subledger (Finance, phase 1)
`id`, `clinic_id` → clinics (`cascade`), `patient_id` → patients (`cascade`),
`appointment_id` → appointments (`set null`; NULL = an unallocated **advance**),
`kind` (`payment` | `advance` | `advance_applied` | `refund`), `amount` int (PKR,
positive; sign from `kind`), `method` (cash/bank/cheque/other — the vocabulary is
declared ONCE in `core/finance/payment-methods.ts` and shared by every form, filter,
zod schema and the day-book grouping; the five `method` columns
[`patient_payments`, `expenses`, `doctor_payouts`, `clinic_payments`,
`company_expenses`] all use it. `imported_transactions.method` deliberately does NOT —
it archives whatever the clinic’s previous system wrote), `reference`, `note`,
`reverses_id` (nullable, self-ref for a void/refund), `occurred_at`, `created_by(+name)`
snapshot, soft-delete, timestamps. Collected on a visit = Σ(payment +
advance_applied) for that appointment; patient **credit** = Σadvance −
Σadvance_applied − Σrefund(unallocated). A void is a soft-delete; the
`appointments.amount_collected` cache is recomputed from the live ledger after every
change (no drift). See `core/billing/*`. Indexes: (`clinic_id`,`patient_id`);
(`appointment_id`); (`clinic_id`,`occurred_at`); partial trash index.

### `invoices` — numbered visit invoices (Finance, phase 1)
`id`, `clinic_id` → clinics (`cascade`), `appointment_id` → appointments (`cascade`),
`patient_id` → patients (`cascade`), `invoice_no` int (per-clinic sequence),
`issued_at`, `issued_by(+name)` snapshot, `note`, soft-delete. One LIVE invoice per
appointment (partial unique on `appointment_id WHERE deleted_at IS NULL`); the number
is allocated by locking the clinic row (`FOR UPDATE`) and bumping
`clinics.next_invoice_no`, shown with `clinics.invoice_prefix`. The bill amount is
NOT stored — derived from `computeBill` at render (thermal/A5/A4 print), the same
formula the lists aggregate in SQL. See
`core/billing/invoice.ts`. Indexes: unique(`clinic_id`,`invoice_no`);
(`clinic_id`,`issued_at`); (`patient_id`).

### `appointment_discount_approvals` — discount sign-off (revenue-share, phase 3)
`id`, `clinic_id` → clinics (`cascade`), `appointment_id` → appointments
(`cascade`), `approver_kind` ('clinic' | 'doctor'), `approver_doctor_id` → users (`cascade`; the
affected doctor for a 'doctor' row, NULL for a 'clinic' row),
`status` ('pending'|'approved'|'rejected', default pending),
`decided_by` uuid (no FK — users are soft-deleted) + `decided_by_name` snapshot +
`decided_at`, `note`, timestamps. One row per party (the clinic and/or each affected
doctor) that must sign off before an appointment's discount applies. Rows are
(re)generated on every discount/borne-by/procedures change by
`core/appointments/approvals.ts#syncDiscountApprovals`, which reads
`clinics.discount_needs_approval` (clinic side) and `users.discount_needs_approval`
(each affected doctor) to decide who is required; the appointment's
`discount_status` is derived from the rows. A doctor decides only their own row; a
'clinic' row needs the `discount_approval` permission. With all switches off + borne
= clinic, no rows are made → status 'none' → the discount just applies (behaviour
unchanged). Indexes: (`appointment_id`); (`clinic_id`,`status`);
(`approver_doctor_id`,`status`).

### `imported_transactions` — read-only financial-history archive (financial-archive-plan.md)
A clinic migrating off its old PMS uploads its old **bills / receipts / expenses /
doctor-payouts** as per-transaction rows so the past is searchable inside FlexicaAI forever.
**READ-ONLY archive — NEVER joined by a live report.** FlexicaAI's money
(sales/shares/receivables/P&L) is DERIVED from completed appointments; these rows never
happened *in FlexicaAI*, so they must not enter those ledgers (a separate table, not an
`imported` flag, makes exclusion the default). ONE generic table with a `type`
discriminator (not five per-entity tables): `id`, `clinic_id` → clinics (cascade), `type`
(free text — 'invoice'|'payment'|'refund'|'expense'|'doctor_payout'), `txn_date` date
(as given, nullable → a warning), `amount` int (PKR, **always positive**; `type` carries
direction — money in = payment, out to a patient = refund, expense/payout = out),
`patient_id` → patients (set null; matched by old-ref → phone → exact name, else archived
UNLINKED) + `patient_name`/`external_patient_ref` snapshots, `doctor_id` → users (set
null; matched by name) + `doctor_name` snapshot, `description`/`reference`/`method`, `raw`
jsonb (**the ENTIRE original row verbatim** — nothing lost, a future specialised report
recoverable without re-import), `import_batch_id` (undo group, no FK), soft-delete,
timestamps. Uploaded ADMIN-side (owner/super-admin/account-manager) via the clinic-detail
importer (`/admin/clinics/[id]/import`, gated by `import:create` + assignment scope),
reusing the whole import machinery (parse → map → dry-run preview **with a reconciliation
totals footer** → batch commit → undo). The clinic gets a READ-ONLY viewer
(`/clinic/history`, gated by the `sales` feature + `billing:view`) with a "Historical —
read-only" banner + type/period/text filters + CSV; `core/finance/imported-history.ts` is
the ONLY reader. The one sanctioned bridge to live data: an **opt-in** (default off) toggle
on the payments commit **SETS** (never adds) each affected patient's
`patients.opening_balance` = max(0, Σ imported invoices − Σ payments + Σ refunds), so the
flat and derived dues paths can't stack. Indexes: (`clinic_id`,`type`,`txn_date`);
`patient_id`; `doctor_id`; `import_batch_id`; pg_trgm on `patient_name`/`doctor_name`;
(`clinic_id`,`reference`); partial trash index. (Migration `0074`.)

---

## 3b. Super-admin control plane & Owner Finance

Company-side tables — how FlexicaAI runs its business (bill clinics, track its own
cost/profit). Some carry `clinic_id` (a tenant reference the super admin reads
cross-tenant via `unscoped`); several are **company-level (no `clinic_id`)** — FlexicaAI's
own data, which the tenant guard therefore ignores. See `docs/super-admin-plan.md`,
`docs/finance-plan.md` and `docs/owner-finance-plan.md`.

**Clinic/user columns added by this layer** (not new tables): `clinics` gained
subscription **billing** (`monthly_price`, `billing_cycle` = the package
monthly/2m/quarter/half/annual, `grace_days`, `payment_reminder_days` [days before the
paid-through date to show a "payment coming up" heads-up, default 5], lifecycle dates
`trial_start_at` / `trial_ends_at` / `activated_at` [= subscription/active start] +
`status`, invoice counter `next_invoice_no`/`invoice_prefix`/`invoice_paper`
[the size a print screen OPENS at] + `invoice_papers_enabled` [which sizes it OFFERS]),
**account-manager** `assigned_to` → users (self-ref FK), a
**payment-commitment** follow-up (`payment_commitment_at`/`_note`), a **health
follow-up / snooze** for churn/usage-flag alerts (`health_followup_at`/`_note` — a
future date parks the clinic under "Following up" on the Owner Overview instead of
nagging in the at-risk/usage-flag lists; `core/admin/health.ts`), and **owner
contact** (`owner_name`/`_email`/`_phone`, `city`, `country`). `users` gained
`deactivated_at` (NULL+inactive = suspended · set+inactive = deactivated),
`permissions` (admin `resource:action` slugs — a NULL list on a super_admin = the
`owner`), `prefix`, `avatar_key`, and the doctor revenue-share `%` columns.

### `clinic_payments` — clinic → FlexicaAI subscription payments
`id`, `clinic_id` → clinics (`cascade`), `amount` int (PKR, always positive),
`kind` (`payment` = money in / `refund` = money out / `credit` = non-cash goodwill;
sign for the balance + cash-collected math comes from this), `method`, `reference`,
`months_covered`, `note`, `occurred_at`, `recorded_by(+name)` snapshot, soft-delete,
timestamps. Balance/status math in `core/admin/billing.ts` (advance/partial-payment,
`computeClinicBalance`); a refund subtracts from paid, a credit adds without cash.
Indexes: (`clinic_id`,`occurred_at`); partial trash index.

### `announcements` — super-admin → clinic notices
`id`, `clinic_id` → clinics (`cascade`, **nullable** — NULL = broadcast to ALL
clinics, else targeted), `level` (info|warning), `title`, `body`, `active` bool,
`starts_at`/`ends_at` (optional window), `created_by(+name)`, timestamps. Shown in the
clinic notice bar. `core/admin/announcements.ts` (cross-clinic reads `unscoped`).

### `platform_cost_rates` — company serving-cost config (Owner Finance) · NO clinic_id
`id`, ESTIMATE rates `scribe_call_cost` (fallback) + `whatsapp_msg_cost`, METERED rates
`whisper_minute_cost` + `claude_input_cost`/`claude_output_cost` (per 1M tokens), all
`numeric` USD; `currency`, `usd_to_pkr` FX; **international-transaction bank TAX/charges**
(`tax_mode` 'itemized'|'total' + `foreign_txn_fee_pct` / `fed_pct` / `advance_tax_pct` /
`additional_tax_pct` and `total_tax_pct`, all `numeric` %, default 0) applied as a **%
markup on the PKR serving cost at report time** (ai_usage stays the raw provider cost).
Itemised effective % = fee + **(FED on the fee)** + advance + additional (FED is charged
on the fee, not the payment — so 16% FED on a 3% fee = 0.48%); or the single total.
Pure/client-safe math in `core/admin/cost-tax.ts#effectiveTaxPct`/`taxMultiplier`
(`FILER_TAX_DEFAULTS` = 3% fee · 16% FED · 5% advance ≈ 8.48%, pre-filled but editable);
`effective_from` (a NEW row per change = rate history; latest = current),
`created_by(+name)`, `created_at`. Drives `computeServingCost` + the dashboard serving-cost
KPI (`metrics.ts`). Index: `effective_from`. (Tax cols: migration `0077`.)

### `ai_usage` — precise AI metering (Owner Finance)
`id`, `clinic_id` → clinics (`cascade`), `visit_id` → visits (`set null`), `provider`
('whisper'|'claude'), `model`, `audio_seconds` (Whisper), `input_tokens`/`output_tokens`
(Claude), `cost_pkr` int (**snapshot** at record-time rates), `occurred_at`. One
whisper + one claude row per scribe run (`core/ai/usage.ts#recordScribeUsage`,
best-effort). `computeServingCost` sums these (falls back to the flat estimate for an
audio visit with no metered row). Indexes: (`clinic_id`,`occurred_at`); (`occurred_at`);
(`visit_id`).

### `company_expense_categories` + `company_expenses` — FlexicaAI's own opex · NO clinic_id
Company operating costs (payroll/rent/software/…). `company_expense_categories`:
`id`, `name`, `is_active`. `company_expenses`: `id`, `category_id` → categories
(`set null`), `amount` int, `incurred_on` date, `vendor`, `method`, `reference`,
`note`, `recurring` + `recurrence` + `next_run_on` (cron `GET /api/cron/company-expenses`),
`created_by(+name)`, **soft-delete**, timestamps. `core/admin/company-expenses.ts`.
Indexes: `incurred_on`; `category_id`; partial trash + recurring-due indexes.

### `clinic_invoices` — FlexicaAI → clinic subscription invoices (Owner Finance)
`id`, `clinic_id` → clinics (`cascade`), `invoice_no` int (**company-global**
sequence, allocated by locking `company_settings` + bumping its counter — distinct
from patient `invoices`), `period_start`/`period_end` date, `amount` int, `note`,
`issued_at`, `issued_by(+name)`, **soft-delete** (a void keeps the number), `created_at`.
Printable receipt reuses the invoice frame. `core/admin/clinic-invoices.ts`. Indexes:
unique `invoice_no`; `clinic_id`; `issued_at`; partial trash index.

### `company_settings` — singleton company config · NO clinic_id
`id`, `next_invoice_no` + `invoice_prefix` (the `clinic_invoices` counter),
`churn_inactive_days` (Overview churn threshold default, 21), `thin_margin_pct` (50) +
`spike_multiple` (3) + `spike_floor_pkr` (200) (the Overview anomaly-flag rules),
timestamps. One row, seeded lazily. `core/admin/company-settings.ts`. The Owner
Overview (`/admin/overview`, `core/admin/health.ts` + `metrics.ts` + `pnl.ts`) reads
these for churn-risk + usage/cost anomaly flags.

---

## 4. Notes

- **Inferred types** are exported from `schema.ts` (`Clinic`, `User`, `Patient`,
  `Appointment`, `Visit`, `Recall`, `WhatsappMessage`, `DoctorLeave`, …) — import
  those rather than redefining row shapes.
- **Slot validation** (leave + working hours + daily cap) is centralised in
  `core/appointments/availability.ts#checkDoctorSlot`; both booking and the WhatsApp
  reschedule use it, so the rules can't drift.
- **Timezone caveat (deploy):** availability, "tomorrow" (reminder), and day
  bounds use the **server's local timezone**. For a multi-region rollout
  (Pakistan vs GCC), pin each clinic to its own timezone.
- Migrations `0000`–`0043` applied; almost always additive (the one drop:
  `0038` removes `sale_shares.payout_id`, superseded by amount-based payouts).
  `0039` adds the Finance billing foundation — `patient_payments` + `invoices`
  tables, `appointments.amount_collected`, and clinic invoice settings
  (`invoice_paper` / `invoice_prefix` / `next_invoice_no`). `0040` adds `expenses`
  (soft-deletable) + `expense_categories`. See docs/finance-plan.md. `0041`
  (discount-bearing phase 1) adds the `discount_settlements` + `doctor_settlement_actions`
  tables and `appointments.discount_split_type` / `discount_split_value` /
  `discount_split_stale`. See docs/discount-bearing-plan.md. `0042` adds the partial
  unique index on `doctor_settlement_actions` (one per-line doctor_waive per line).
  `0043` adds `expenses.recurrence` ('monthly'|'weekly') + `expenses.next_run_on`
  date (+ a partial due-index) — the recurring-expense cron
  (`core/expenses/recurring.ts`, `GET /api/cron/expenses`) clones a recurring
  template into a plain expense each period and advances `next_run_on`.
  (`0017` adds `appointments.discount_type` / `discount_value`; `0018` adds
  `appointments.queue_session` / `queue_number` + the queue unique index; `0019`
  adds the `activity_logs` table; `0020` adds `clinics.log_access` and drops the
  now-unused `activity_logs.visible` — log access is permission-based, not
  time-based; `0021` adds the `procedures` table; `0022` adds `appointment_procedures`;
  `0023` adds the `sales` ledger table; `0024` adds
  `appointments.charge_consultation`; `0025` adds
  `appointment_procedures.discount_type` / `discount_value` for per-line discounts;
  `0026` adds the `manager` user_role value + `users.permissions` (per-user ACL);
  `0027` adds soft-delete columns (`deleted_at`/`deleted_by`/`delete_group`/
  `deleted_by_cascade`) to the 8 deletable tables + `clinics.trash_retention_days`,
  makes `users` username/email uniqueness partial (`WHERE deleted_at IS NULL`), and
  adds per-table partial trash indexes; `0028` adds `patients.reference`; `0029`
  adds the per-clinic WhatsApp sender columns (`whatsapp_phone_number_id` [partial
  unique] / `whatsapp_display_number` / `whatsapp_sender_name` / `whatsapp_signature`);
  `0030` drops the unused `whatsapp_notes` (per-event notes feature removed);
  `0031` adds `users.prefix` (name title — Dr/Mr/Miss…, shown as "Dr. Bilal Aziz");
  `0032` adds `users.avatar_key` (profile picture, served self-only via
  GET /api/me/avatar; the `/account` self-service settings page); `0033` adds the
  doctor revenue-share foundation — `users.consultation_share_pct` /
  `procedure_share_pct`, `appointments.discount_borne_by`,
  `appointment_procedures.doctor_id` (performing doctor), and the
  `doctor_procedure_shares` table (per-doctor per-procedure % overrides). See
  `docs/doctor-shares-plan.md`; split math in `core/appointments/shares.ts`, rate
  config in `core/appointments/share-config.ts`. `0034` adds the discount-approval
  switches `users.discount_needs_approval` (per doctor) + `clinics.discount_needs_approval`
  (per clinic). `0035` adds `appointments.discount_status` + the
  `appointment_discount_approvals` table (the discount approval workflow —
  `core/appointments/approvals.ts`). `0036` adds the `sale_shares` per-doctor share
  ledger (`core/sales/share-ledger.ts`). `0037` adds the `doctor_payouts` table +
  the `sale_shares.payout_id` FK (`core/sales/payouts.ts`) — completing the doctor
  revenue-share v1. `0038` (Phase 7) switches payouts to an AMOUNT-based running
  balance: drops `sale_shares.payout_id`, adds `doctor_payouts.method`/`reference`
  — arbitrary/partial payments + a printable statement.)
- Migrations **`0044`–`0063`** — the **super-admin control plane + Owner Finance**
  (see §3b; `docs/super-admin-plan.md`, `docs/owner-finance-plan.md`). Roughly:
  `0044`–`0053` build the super-admin panel — clinic subscription **billing**
  (`clinic_payments` + the `clinics` billing columns), **2FA/security**, the admin
  **ACL** (`users.permissions` admin slugs), clinic **capabilities**/features,
  owner **contact** columns, **impersonation**, company **metrics**, and
  **`announcements`** (`0053`). `0054` adds `clinics.payment_commitment_at/_note`;
  `0055` adds `clinics.assigned_to` (account manager, self-ref FK); `0056` adds
  `users.deactivated_at` (suspend vs deactivate). Owner Finance: `0057`
  `platform_cost_rates`; `0058` `company_expenses` + `company_expense_categories`;
  `0059` `company_settings` + `clinic_invoices`; `0060` `clinic_payments.kind`
  (payment/refund/credit → cash-aware collected); `0061` `ai_usage` + the metered
  Whisper/Claude rate columns on `platform_cost_rates`; `0062`
  `company_settings.churn_inactive_days`; `0063` `company_settings` anomaly-flag
  thresholds (`thin_margin_pct`/`spike_multiple`/`spike_floor_pkr`).
- Migration **`0069`** adds `clinics.health_followup_at`/`health_followup_note` —
  the Owner Overview churn/usage-flag follow-up (snooze). A future date moves the
  clinic to the "Following up" list and out of the at-risk/usage-flag alerts until
  it passes. `core/admin/health.ts` (`getClinicHealth` + `setHealthFollowup`).
- Migration **`0070`** adds `clinics.payment_notice_enabled` (bool, default true) —
  whether the SOFT payment-due/overdue reminder is shown to the clinic's own staff
  (a bottom pill in the workspace). Owner / super-admin / the account manager toggle
  it per clinic; it does not affect the super-admin dues dashboard or the hard
  `past_due` lock. `core/admin/billing.ts#setPaymentNoticeEnabled`, gated in
  `src/app/clinic/layout.tsx`.
- Migration **`0071`** adds `clinics.logo_key` (text, nullable) — the clinic's logo
  (opaque local-FS storage key, per-clinic `logo/` subdir; cap 1 MB, see
  `core/clinics/logo-limits.ts`). Uploaded by owner/super-admin/account-manager (clinic
  detail "Logo" card + optionally the new-clinic form); printed **as uploaded** at the
  top of invoices/receipts (a B&W/thermal printer renders it mono), inlined as a base64
  data URI for print reliability (`core/clinics/logo.ts#getClinicLogoDataUri`); the admin
  preview is served via `GET /api/admin/clinics/[id]/logo`. NULL = print nothing.
- Migration **`0072`** — patient-invoice numbers **reset per year**. Adds
  `clinics.invoice_year` (the year `next_invoice_no` belongs to) + `invoices.invoice_year`,
  and swaps the invoice unique index to (`clinic_id`,`invoice_year`,`invoice_no`) since the
  number restarts at 1 each January. Label is now `<invoice_prefix><YYYY>-<7-digit>` (e.g.
  `INV-2026-0000005`, `core/billing/invoice.ts#formatInvoiceNo`); allocation locks the
  clinic row and resets on a year rollover. Existing invoices backfilled (`invoice_year`
  from `issued_at`) and re-rendered in the new format. (Distinct from the company-side
  `clinic_invoices`, which keeps its own global numbering.)
- Migration **`0073`** — **payment-receipt numbering** (RCP series, distinct from
  invoices). Adds `clinics.receipt_prefix`/`next_receipt_no`/`receipt_year` +
  `appointments.receipt_no`/`receipt_year` (partial-unique per clinic+year). The number
  is allocated ONCE on the first money-in for a visit (`core/billing/payments.ts#ensureReceiptNumber`,
  clinic-row-locked, resets per year) → label `<receipt_prefix><YYYY>-<7-digit>` (e.g.
  `RCP-2026-0000012`, `formatReceiptNo`). Existing paid visits backfilled. The receipt
  prints the RCP # + a per-payment breakdown; the `/clinic/payments` ledger is searchable
  by payment # (RCP) and MRN #.
- Migration **`0074`** — the **read-only financial-history archive**: adds the
  `imported_transactions` table (see §3). One generic table (type discriminator + `raw`
  jsonb) for a clinic's pre-FlexicaAI bills/receipts/expenses/doctor-payouts, uploaded
  admin-side via the existing clinic-detail importer (four new `ImportEntity` passes —
  `fin_invoice`/`fin_payment`/`fin_expense`/`fin_payout` — all writing this one table,
  undo via `import_batches`), viewed read-only at `/clinic/history`. Excluded from every
  live report by construction; the only bridge is the opt-in `opening_balance` derivation.
  See docs/financial-archive-plan.md.
- Migration **`0075`** adds `clinics.trial_start_at` (timestamptz) — when a clinic first
  enters `trial` (stamped by `setClinicStatus`/`extendTrial`, never overwritten; existing
  trial clinics backfilled from `created_at`). Distinct from `created_at`; pairs with
  `activated_at` (active/subscription start). The super-admin **clinics list** (`/admin`)
  now shows trial-start / active-start / **first payment** (earliest `clinic_payments`
  payment via `getFirstPaymentDates`) / **package** (`billing_cycle`); the two billing
  columns are billing-viewer-only, and the wide table scrolls horizontally.
- Migration **`0076`** adds `clinics.payment_reminder_days` (int, default 5) — how many
  days before the paid-through date a still-paid clinic surfaces in **"Payments coming
  up"** on `/admin` + `/admin/overview` (a pre-due heads-up, distinct from due/overdue).
  Set per clinic on the billing card (owner/super-admin/account-manager, `setPayment
  ReminderDaysAction`); `listDueClinics({ includeUpcoming })` adds the `upcoming` alert
  bucket (an `active` clinic with `daysRemaining ≤ payment_reminder_days`). 0 disables it.
- Migration **`0077`** adds international-transaction **bank tax/charge** columns to
  `platform_cost_rates` — `tax_mode` ('itemized'|'total') + `foreign_txn_fee_pct` /
  `fed_pct` / `advance_tax_pct` / `additional_tax_pct` / `total_tax_pct` (all `numeric`,
  default 0). The effective % (summed itemised, or the single total) is a **markup on the
  PKR serving cost** (a PK bank deducts a foreign-transaction fee + FED + advance tax when
  FlexicaAI pays the AI/WhatsApp providers in USD); applied in `computeServingCost` +
  `getCompanyMetrics` via `core/admin/cost.ts#taxMultiplier`. Editable on
  `/admin/finance/costs`. Verified: itemised 10% and total 8% scale the cost exactly; 0 = no change.
- Migration **`0079`** adds a partial unique index on `whatsapp_messages(external_id)`
  for INBOUND rows — provider webhook idempotency, so a redelivery can't log the
  message twice or re-run patient self-service booking. Scoped to inbound on purpose:
  outbound ids come from a loosely-typed provider response, and a unique index
  spanning them could start rejecting real sends at log time.
- Migration **`0080`** caps PERCENT discounts at 100 — CHECK constraints on
  `appointments` (`discount_value`, `discount_split_value`) and
  `appointment_procedures` (`discount_value`). Unbounded, a mistyped percentage
  overflowed int4 inside the bill SQL and made Postgres THROW where TypeScript
  clamped, 500-ing every list that aggregates bills for that clinic (ADR-021 / D-17).
  The migration clamps existing rows first, because `ADD CONSTRAINT` validates
  existing data and one stale row would fail the deploy. A flat AMOUNT stays
  unbounded — the bill clamps it, and a large write-off is legitimate.
- Migration **`0081`** bounds `activity_logs` (delta D-11 / ADR-023). Adds
  `company_settings.activity_log_retention_days` (int, default **0 = keep everything**
  — deliberately inert, since how long an access log over patient data must survive is
  a regulatory decision) and the partial index
  `activity_logs_view_dedupe_idx (actor_user_id, entity, entity_id, created_at desc)
  WHERE action = 'view'`. That index serves `logView`'s de-dupe check, which ran on
  every record open with NO index at all — Postgres walked the global `created_at`
  index and filtered, so one user opening one patient got slower as OTHER clinics got
  busier. **Do not rewrite the null-`entity_id` branch as `IS NOT DISTINCT FROM`:** it
  is not btree-indexable and silently drops the plan from an Index Only Scan to a
  bitmap scan plus filter (verified on 60k rows).
- Migration **`0084`** adds **vocabulary CHECK constraints to the 16 money-path
  columns** — `patient_payments.kind`/`.method`, `clinic_payments.kind`/`.method`,
  `doctor_payouts.method`, `expenses.method`, `company_expenses.method`,
  `doctor_settlement_actions.kind`, `discount_settlements.party`,
  `appointment_discount_approvals.approver_kind`/`.status`,
  `appointment_procedures.discount_type`, and `appointments.discount_type` /
  `discount_split_type` / `discount_borne_by` / `discount_status`. **The selection rule
  is the point:** each is a branch money arithmetic takes, and every consumer falls back
  to a default rather than raising — `plActionEffect` (`core/finance/pl.ts`) returns 0
  for an unrecognised settlement kind, `aggregateCash` ignores a payment kind it does
  not know, the bill treats any non-`'percent'` discount type as a flat amount. So a bad
  value produces a WRONG FIGURE, silently, not an error. Columns whose worst case is a
  wrong badge colour or paper size (`announcements.level`, `ai_usage.provider`,
  `clinics.invoice_paper`, `clinical_attachments.kind`, the treatment-plan statuses,
  `import_batches.status`, `recurrence`) are deliberately left unconstrained, and the
  open vocabularies (`module`, `activity_logs.action`/`entity`, `notifications.type`,
  `imported_transactions.type`/`.method`, `ai_usage.model`) must stay that way.
  **Two vocabularies were WIDER than their column comments claimed**, found by auditing
  the writes rather than trusting the comments: `patient_payments.kind` has a fifth
  value `'opening'` (`settleOpeningBalance`, read in five places), and
  `doctor_settlement_actions.kind` permits `'reversal'`, designed for but not yet
  written. Constraining to the documented set would have rejected live rows.
  **Unlike `0080`, this migration rewrites NOTHING**: there is no safe automatic mapping
  for an unknown vocabulary value, since silently reclassifying a money row would change
  ledger and P&L figures unasked. It opens with a `DO` block that fails loudly instead,
  naming the table, column, row count and offending values. Note a CHECK is satisfied
  when its expression is true **or NULL**, which is what keeps the nullable `method`
  columns writable when unset — never "tighten" one with `and … is not null`.
  `scripts/test-vocabulary-bounds.ts` proves all 16 fire (32 checks; tables that are
  empty on a fresh install are exercised with rolled-back probe INSERTs rather than
  skipped, since an unproven constraint reported as passing is how a decorative one
  survives).
- Migration **`0085`** widens `patient_payments_method_valid` to include **`'advance'`**.
  `0084` constrained the column to the four TENDERS a receptionist can pick, but
  `applyAdvance` (`core/billing/payments.ts`) settles a bill from stored credit and
  records `method = 'advance'` — a **system marker**, not a tender: no money changes
  hands, so it is deliberately absent from every dropdown. `0084` therefore rejected a
  legitimate write path. `core/finance/payment-methods.ts` now distinguishes the two:
  `PAYMENT_METHODS` (offered in forms, validated by zod) vs `SYSTEM_PAYMENT_METHODS`,
  with `STORED_PAYMENT_METHODS` — what the column may hold — mirroring the constraint.
  The other four `method` columns stay tender-only; nothing writes a marker to them.
  **Why the `0084` audit missed it, worth remembering before adding the next
  constraint:** the pre-flight ran `SELECT DISTINCT` over existing DATA and found
  nothing out of set — but no advance had ever been applied on that database, so the
  value was not there to find. Auditing rows proves what HAS been written; it says
  nothing about what the CODE can write. Grep the write paths too.
- Migration **`0086`** adds `appointments.custom_time` (bool, default false) — staff
  booked this visit at a time OUTSIDE the doctor's configured windows (a procedure at
  6pm for a doctor who consults 1–3pm). Passed to
  `checkDoctorSlot(..., { customTime })`, which then skips the **working-hours** check
  and **only** that one: leave and the daily cap still apply, because agreeing to come
  in at 6pm is not the same as being available during your holiday or past your own
  cap. **Stored rather than derived** — the schedule can change afterwards, and without
  the flag a later edit would re-validate against TODAY's hours and refuse to save a
  visit that was deliberately booked outside them. Distinct from `users.flexible_hours`
  (per DOCTOR, always free) and from a `kind: "procedure"` availability window (per
  DOCTOR, recurring weekly): this is the per-APPOINTMENT exception. The booking form
  frees its time picker on the same condition, so it can never offer a time the action
  would refuse. Default false leaves every existing appointment unchanged.
  `scripts/test-custom-time.ts`.
- Migrations **`0087`–`0088`** turn the money-path vocabularies into **reference tables
  with integer foreign keys** (owner's direction, 2026-09-02), replacing the CHECK
  constraints of `0084` with referential integrity. Nine tables — `payment_kinds`,
  `clinic_payment_kinds`, `payment_methods`, `settlement_kinds`, `settlement_parties`,
  `approval_statuses`, `discount_statuses`, `discount_types`, `discount_bearers` — each
  `(id, code, label, sort_order, is_active)`, company-global (no `clinic_id`, so the
  tenant guard ignores them). The 16 columns gained a `*_id` FK; the 11 whose text
  source is NOT NULL are NOT NULL too, and the 7 with a text default carry the matching
  id default (`0088`), so inserts that never mention a discount keep working.
  **Ids are written out, never assigned by a sequence.** A surrogate key only means
  anything if the same number means the same thing in every environment; a `serial`
  assigns by insertion order, so a re-seed in a different order would silently
  reclassify money already recorded. The literals live in `src/core/db/vocabulary-seed.ts`
  and `scripts/test-vocabulary-tables.ts` asserts the DB matches it row for row.
  **The text columns are deliberately KEPT for now** — dropped only once every read uses
  the id, so the step is reversible and the two can be proven to agree first. Writes go
  through paired helpers (`paymentKindFields("refund")` sets `kind` AND `kindId`), so
  the two cannot drift while both exist. **What an FK cannot do:** it enforces "exists
  in the table", not "is in a SUBSET of it". `payment_methods` holds the four tenders
  plus the system marker `advance` (written only by `applyAdvance`); `0084`/`0085` kept
  `advance` out of the four non-patient method columns and an FK cannot, so that
  restriction now lives in zod alone.
- Migrations **`0088`–`0089`** finish the conversion: `0088` mirrors each text column's
  DEFAULT onto its id column, and `0089` **drops the 16 text columns** together with the
  CHECK constraints of `0084`/`0085`, which the foreign key subsumes. The columns in the
  database are now `kind_id`, `method_id`, `party_id`, `approver_kind_id`, `status_id`,
  `discount_type_id`, `discount_split_type_id`, `discount_borne_by_id`,
  `discount_status_id` — all `integer NOT NULL` (except the five nullable `method_id`),
  all with an FK.
  **The application still reads and writes CODES.** `core/db/schema/vocabulary.ts#vocabularyRef`
  is a Drizzle `customType` storing the integer and presenting the code, so
  `eq(patientPayments.kind, "refund")` still compiles and emits `kind_id = 4`. That is
  what let ~120 read sites — every one of them money arithmetic or a money report —
  stay untouched; rewriting them by hand was the largest risk in the change. The
  property types are now literal unions, so a mistyped code fails to COMPILE.
  **What is genuinely lost:** `select … where kind = 'refund'` at a psql prompt is now
  `kind_id = 4`; join the lookup table to read it. Raw SQL in the app compares against
  `paymentKindId("refund")` rather than a string.
  **Two drizzle-kit outputs had to be hand-corrected**, both silent if missed: `ADD
  COLUMN … NOT NULL` with no default (fails on a table with rows — rewritten as
  add-nullable → backfill → SET NOT NULL), and `SET DEFAULT 'pending'` on an integer
  column, because drizzle-kit does not run a custom type's `toDriver` when generating
  DDL. `scripts/test-vocabulary-tables.ts` replaces `test-vocabulary-bounds.ts`.
- Migration **`0090`** converts the **seven ENUM-backed vocabularies** to reference
  tables with integer foreign keys: `appointment_statuses`, `visit_statuses`,
  `recall_statuses`, `user_roles`, `theme_preferences`, `whatsapp_directions`,
  `whatsapp_statuses`. `appointments.status`, `visits.status`, `recalls.status`,
  `users.role`, `users.theme`, `whatsapp_messages.direction`/`.status` are all
  `integer` now. **The FK adds no integrity here** — Postgres already refused a value
  outside an enum. What it adds is a ROW per value, which is what lets a label be
  renamed, a dropdown reordered, or a value retired without a deploy; the old enum
  TYPES are left in place, unreferenced, so the migration stays reversible.
  **Three drizzle-kit outputs had to be corrected, each silently wrong:**
  `SET DATA TYPE integer` with no `USING` (Postgres will not cast an enum to an integer
  — and the USING must be a literal `CASE`, since a SUBQUERY is rejected outright with
  "cannot use subquery in transform expression"); the existing DEFAULT must be DROPPED
  before the type change; and `SET DEFAULT 'scheduled'` on an integer column.
  **A partial index blocked the conversion:** `wa_messages_inbound_external_id_unique`
  (migration `0079`) has the predicate `direction = 'inbound'::whatsapp_direction`, so
  the ALTER failed with "operator does not exist: integer = whatsapp_direction". It is
  dropped before the type change and recreated against the id.
  **`activity_logs.actor_role` is deliberately NOT converted** — it is a text SNAPSHOT
  that must survive the role vocabulary changing, like `sales.doctor_name`.
- **`src/core/db/vocabulary-cache.ts`** makes the DATABASE the source of the label,
  sort order and active flag for every vocabulary, loaded once at start-up from
  `src/instrumentation.ts` (guarded on `NEXT_RUNTIME === "nodejs"`; the Edge runtime
  has no pool). `vocabularyOptions()` / `vocabularyLabel()` read it, so renaming
  "In progress" to "With the doctor" is a row update — verified end to end.
  **Why the compiled constants remain:** Drizzle's `customType` mappers are
  SYNCHRONOUS and cannot query, so the id↔code map must be resolvable in memory; the
  cache falls back to the seed when cold, which is safe precisely because
  `loadVocabularies` reports any disagreement between the two at start-up. **The code
  still owns what a value MEANS** — `nextQueueAction` switches on a status, `can()` on
  a role — so a row inserted into the database alone would be stored and never acted
  on. Adding a NEW value is still a code change; the database owns presentation.
- Migration **`0091`** drops the seven enum TYPES themselves, now that `0090` has moved
  every column off them; `pg_attribute` was checked first and showed zero columns using
  each. The `pgEnum` declarations are gone from the schema files with them. **This is
  the point of no easy return for `0090`** — recreating a type is trivial, but the data
  would have to be mapped back from ids, which is why `0090` deliberately left them
  standing until the conversion had been exercised.
- Migration **`0092`** converts the last twelve free-text vocabularies — `clinic_statuses`,
  `billing_cycles`, `invoice_papers`, `treatment_plan_statuses`, `treatment_item_statuses`,
  `attachment_kinds`, `import_batch_statuses`, `announcement_levels`, `ai_providers`,
  `tax_modes`, `recurrences`, `appointment_sources` — covering thirteen columns
  (`recurrences` backs both `expenses.recurrence` and `company_expenses.recurrence`).
  **Here the FK is genuine NEW integrity:** these had no enum, no CHECK, nothing. They
  came last because a bad value's worst case was a wrong badge or paper size rather
  than a wrong money figure. `appointments.source` is included because it drives
  behaviour — `whatsapp` marks a self-booking that stays a request until staff confirm.
  Both `recurrence` columns and `ai_usage.provider` keep their nullability.
  **Sixteen columns are now covered by `scripts/test-vocabulary-tables.ts` — thirty-six
  in total across `0087`/`0090`/`0092`**, each asserted to carry its FK in `pg_constraint`.
- Migration **`0094`** adds the dental MODULE's own vocabularies — `dental_lab_statuses`
  and `dental_lab_items` — and turns `lab_cases.status` and `.item` into integer foreign
  keys. The tables live in `src/modules/dental/db/schema.ts` and their seed rows in
  `src/modules/dental/vocabulary.ts`; **core never imports either** (ADR-028). The
  module declares them on its `ModuleDefinition`, `config/modules.ts` aggregates, and
  the app injects at start-up — so core keeps walking only what it is handed. Same rules
  as core's vocabularies: ids written out and never renumbered, the database owns the
  label, the code owns what a value means. **NOT converted: the tooth chart.** Its
  vocabulary lives in jsonb, which cannot carry a foreign key, so `tooth-status.ts`
  stays the source and a compile-time exhaustiveness check keeps it in step with the
  `ToothStatus` union.
- Migration **`0095`** adds `clinics.cancel_cutoff_hours` (int, default 4) — how many
  hours before an appointment a PATIENT may still cancel it themselves over WhatsApp
  (`whatsapp_cancel` feature). Later than that the request goes to the front desk:
  cancelling twenty minutes beforehand is a no-show wearing a polite hat, and whether
  to accept one is a conversation rather than a rule. A column and not a constant
  because clinics disagree and it gets negotiated during a sale; 0 disables it.
- Migration **`0096`** adds the `chat_intents` vocabulary and
  `whatsapp_messages.intent` (nullable integer FK) — what the AI assistant read an
  INBOUND message as. NULL on outbound and whenever the assistant never ran (feature
  off, rate limited, or the deterministic handler took it, which is the common case).
  Recorded for ONE reason: `clinical` is countable rather than merged into `other`,
  and how often patients ask clinical questions is the number that decides whether
  triage is ever worth building (docs/whatsapp-ai-plan.md). Without it the question is
  unanswerable.
- Migration **`0097`** adds the `fee` chat intent (id 7) — a patient asking what a
  NAMED DOCTOR charges for a consultation, answered from `users.consultation_fee`.
  **Data-only**, so drizzle-kit generates nothing: the journal entry and snapshot are
  hand-written. Id **7**, not slotted in beside `price` where it belongs by meaning,
  because ids are never renumbered (ADR-027) — reordering would silently reclassify
  rows already recorded.
- Migration **`0098`** adds the `hours` chat intent (id 8) — a patient asking when
  the clinic or a doctor is available. Data-only, like `0097`. **There is deliberately
  NO clinic-level opening-hours column behind it:** the only hours in the system are
  per doctor (`users.availability`), and those are what govern bookability. A separate
  clinic field could say "Sun 10–2" while no doctor works Sunday, so a patient would
  read it, try to book and be refused — two sources of truth, one of which lies.
  `clinics.address` is unrelated and NOT patient-facing: it is a super-admin CRM field
  used as the bill-to line on FlexicaAI's own subscription invoices.
- Migrations **`0099`–`0100`** add the clinic's PUBLIC contact details —
  `clinics.public_address` and `clinics.opening_hours` (both text, nullable), plus the
  `location` chat intent (id 9). Edited by the CLINIC ADMIN on `/clinic/settings`.
  **`public_address` is deliberately NOT the existing `address`**, which is a
  super-admin CRM field used as the bill-to line on FlexicaAI's subscription invoices;
  a group's billing may go to a head office while the patient needs the branch, and
  there is no fallback between them. **`opening_hours` is STRUCTURED jsonb (migration `0101`) and DISPLAY-ONLY**
  — it drives nothing, and `checkDoctorSlot` is untouched. Bookability comes from each
  doctor's `availability`, and the WhatsApp timings reply prints BOTH ("we're open" and
  "when our doctors see patients") so the clinic's own words can never mislead about
  when a patient can actually be seen.
- Migration **`0101`** retypes `clinics.opening_hours` from text to **jsonb** — one row
  per window, `{weekday, start, end}`, like `users.availability` minus its `kind`. A
  weekday with no rows is CLOSED; several rows for one weekday is a split shift (a
  Friday that breaks for Jummah and reopens), which is the case that decided the shape.
  **Hand-written as DROP + ADD:** drizzle-kit emitted `ALTER COLUMN … SET DATA TYPE
  jsonb`, which fails on any existing row, and free text like "Mon–Sat 10–8" is not
  reliably parseable into windows — guessing would put words in a clinic's mouth.
  Validated on the way in by `core/lib/clinic-hours.ts` (jsonb is not an exemption,
  conventions §4), capped at 21 windows. Still display-only; `checkDoctorSlot` is
  untouched.
- Migration **`0102`** adds `clinics.invoice_papers_enabled` text[] (default all three)
  — which paper sizes a clinic's print screens OFFER, distinct from `invoice_paper`,
  which is the one they OPEN at. A clinic with no A5 printer had no way to stop being
  asked about A5 on every invoice, receipt, statement, chart print and estimate.
  **Two invariants, both enforced in `core/clinics/settings.ts#setInvoicePapers` rather
  than in the form**, because the form is not the only thing that could ever write here:
  the list is never empty, and the default is always a member of it (switching off the
  current default MOVES the default rather than leaving a print screen opening at a size
  it no longer offers). The action rejects both violations with a message; the write path
  also repairs them, so a bad pair cannot be stored either way.
  **A single enabled size hides the picker entirely** — `InvoicePrintFrame` drops the
  whole Format row at `offered.length <= 1`, since a one-option chooser is a control
  that cannot do anything. `allowed` is optional and falls back to ALL sizes when
  absent or unrecognised, so the admin-side subscription-invoice print (a COMPANY
  document, not a clinic one) is deliberately left unchanged.
  `scripts/test-print-papers.ts`.
- Migration **`0082`** makes the scribe ASYNC (delta D-08 / ADR-020). Adds
  `transcribing` and `failed` to the `visit_status` enum, plus
  `visits.transcribe_started_at` (timestamptz) and `visits.transcribe_error` (text).
  `POST /api/ai/scribe` now stores the audio, inserts the visit as `transcribing` and
  returns **202**; `core/ai/scribe-job.ts` fills it in from Next's `after()`. **Both new
  states are invisible to every clinical surface by construction** — each one filters
  `= 'draft'` or `= 'approved'` — which is worth preserving if you ever add a status.
  `transcribe_started_at` is the CLAIM: the job sets it before calling a provider, so a
  retry racing the recovery cron does the paid work once. The recovery sweep
  (`/api/cron/scribe-recover`, the 8th job) matches on
  **`coalesce(transcribe_started_at, created_at) < cutoff`** — a run whose `after()`
  callback never fired has a NULL start time, and `null < cutoff` is NULL, so a plain
  comparison would miss forever exactly the runs it exists to catch.
