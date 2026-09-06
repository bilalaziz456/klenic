-- drizzle-kit emitted `ALTER COLUMN "opening_hours" SET DATA TYPE jsonb`, which FAILS
-- on any existing row: the column held free text ("Mon–Sat 10:00 AM – 8:00 PM, closed
-- Sunday") and Postgres will not cast that to jsonb. Rewritten by hand, as every
-- type-change migration in this repo has had to be (see ADR-027's notes on 0087/0090).
--
-- DROP AND ADD, not a conversion with a USING clause. A sentence a human typed is not
-- reliably parseable into per-day windows, and a best-effort guess would put words in
-- a clinic's mouth about when it is open. The field is one day old (0099) and
-- display-only, so the honest move is to discard it and let each clinic re-enter its
-- hours in the new editor.
ALTER TABLE "clinics" DROP COLUMN "opening_hours";--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "opening_hours" jsonb;
