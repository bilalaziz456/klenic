import { getMyProfile } from "@/core/users/profile";
import { requireWorkspace } from "@/core/auth/user";
import { getClinic } from "@/core/clinics/get-clinic";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/core/ui/card";
import {
  AvatarForm,
  ProfileForm,
  PasswordForm,
} from "@/core/ui/account-forms";
import { PrintingForm } from "./printing-form";
import { PublicContactForm } from "./public-contact-form";

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * Settings — the signed-in user's own account: profile, picture and password.
 * In-panel (keeps the sidebar). Every clinic user manages their OWN account, so
 * this is not permission-gated; the actions are self-scoped (requireUser).
 */
export default async function ClinicSettingsPage() {
  const current = await requireWorkspace();
  const u = await getMyProfile(current.id);
  if (!u) return null;

  const displayName = u.fullName ?? u.username;
  // Clinic-wide printing default — clinic admin only (an operational choice that
  // depends on the clinic's own printer).
  const clinic =
    current.role === "clinic_admin" && current.clinicId ? await getClinic(current.clinicId) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Your profile and password.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile picture</CardTitle>
          <CardDescription>Shown next to your name in the app.</CardDescription>
        </CardHeader>
        <CardContent>
          <AvatarForm
            initials={initialsOf(displayName)}
            hasAvatar={Boolean(u.avatarKey)}
            version={u.avatarKey ?? "none"}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Your name, title and contact email.</CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileForm
            prefix={u.prefix}
            fullName={u.fullName}
            email={u.email}
            username={u.username}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>Change your login password.</CardDescription>
        </CardHeader>
        <CardContent>
          <PasswordForm />
        </CardContent>
      </Card>

      {clinic ? (
        <Card>
          <CardHeader>
            <CardTitle>Clinic details</CardTitle>
            <CardDescription>
              The address and opening hours patients are told when they ask on WhatsApp.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PublicContactForm
              address={clinic.publicAddress}
              hours={clinic.openingHours ?? null}
            />
          </CardContent>
        </Card>
      ) : null}

      {clinic ? (
        <Card>
          <CardHeader>
            <CardTitle>Printing</CardTitle>
            <CardDescription>
              Which paper sizes your print screens offer, and which one opens first.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PrintingForm
              paper={clinic.invoicePaper ?? "a4"}
              enabled={clinic.invoicePapersEnabled}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
