/**
 * Print-size settings: which sizes a clinic OFFERS, and which opens first.
 *
 * The default and the available list are two different questions, and the bug this
 * feature fixes was conflating them: every size was offered on every print screen, so
 * a clinic with one thermal printer saw A5 on every invoice and a receptionist could
 * pick a size the printer cannot produce.
 *
 * What this pins is the pair of invariants, because the failure they prevent — a
 * clinic that can print NOTHING — is worse than anything the feature adds.
 *
 * Run: `tsx --env-file=.env.local --tsconfig scripts/_seed/tsconfig.json scripts/test-print-papers.ts`
 */
import { eq } from "drizzle-orm";
import { db } from "@/core/db";
import { clinics } from "@/core/db/schema";
import { unscoped } from "@/core/db/tenant-guard";
import { setInvoicePapers } from "@/core/clinics/settings";
import { getClinic } from "@/core/clinics/get-clinic";

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  }
}

const TAG = `pp${Date.now()}`;
let clinicId = "";

const read = () =>
  unscoped("test: read the clinic back", () =>
    db.select({ papers: clinics.invoicePapersEnabled, paper: clinics.invoicePaper })
      .from(clinics).where(eq(clinics.id, clinicId)).limit(1));

async function main() {
  [{ id: clinicId }] = await db.insert(clinics)
    .values({ name: `${TAG} clinic`, modulesEnabled: ["dental"] })
    .returning({ id: clinics.id });

  console.log("A new clinic is offered everything, so nothing changes for anyone:");
  {
    const [c] = await read();
    check("all three sizes enabled by default", [...c.papers].sort(), ["a4", "a5", "thermal"]);
  }

  console.log("\nTurning a size off removes it — the whole point:");
  {
    await setInvoicePapers(clinicId, ["thermal", "a4"], "thermal");
    const [c] = await read();
    check("A5 is gone", [...c.papers].sort(), ["a4", "thermal"]);
    check("…and the default is what was asked for", c.paper, "thermal");
  }

  console.log("\nThe default can never be a size that is not offered:");
  {
    // Asking for a default outside the list is the exact mistake that would open a
    // print screen on a button that is not there.
    await setInvoicePapers(clinicId, ["thermal", "a4"], "a5");
    const [c] = await read();
    check("an out-of-list default is corrected, not stored", c.paper, "thermal");
    check("…and the list is untouched", [...c.papers].sort(), ["a4", "thermal"]);
  }

  console.log("\nA clinic can never be left unable to print:");
  {
    await setInvoicePapers(clinicId, [], "a4");
    const [c] = await read();
    check("an empty list falls back to the default", c.papers, ["a4"]);
    check("…which is then also the default", c.paper, "a4");
  }

  console.log("\nOne size left means the print screens show no picker at all:");
  {
    await setInvoicePapers(clinicId, ["thermal"], "thermal");
    const c = await getClinic(clinicId);
    check("exactly one size offered", c?.invoicePapersEnabled, ["thermal"]);
    // `InvoicePrintFrame` renders the Format row only when offered.length > 1.
    check("…so there is nothing to switch between", (c?.invoicePapersEnabled ?? []).length > 1, false);
  }

  await unscoped("test teardown", () => db.delete(clinics).where(eq(clinics.id, clinicId)));
  console.log("\nseeded rows removed");
}

main()
  .catch(async (e) => {
    failures++;
    console.error(e);
    try { await unscoped("teardown", () => db.delete(clinics).where(eq(clinics.id, clinicId))); } catch { /* best effort */ }
  })
  .finally(() => {
    console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
