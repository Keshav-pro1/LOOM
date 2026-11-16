import { redirect } from "next/navigation";
import { getRequestContext, hasCurrentConsent } from "@/lib/auth-server";
import { homeForRole } from "@/lib/auth";
import { POLICY_VERSIONS } from "@/lib/legal";
import { AuthShell } from "../(auth)/_components/AuthShell";
import { ConsentForm } from "./ConsentForm";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Consent",
  robots: { index: false, follow: false }
};

export default async function ConsentPage() {
  const ctx = await getRequestContext();
  if (!ctx.user) redirect("/login?redirect=/consent");
  if (!ctx.profile || !ctx.tenant) redirect("/login?redirect=/consent");

  // Where "Accept and continue" goes. This used to be a hardcoded /student, so a
  // lead or admin who accepted the policies was dropped into the student
  // workspace; the layout then had to bounce them a second time.
  const role = ctx.profile?.role;
  const next =
    role === "student" && !ctx.profile?.onboarding_completed
      ? "/student/onboarding"
      : homeForRole(role);

  const current = await hasCurrentConsent(ctx.sql, {
    userId: ctx.user.id,
    tenantId: ctx.tenant.id
  });
  if (current) redirect(next);

  return (
    <AuthShell>
      <p className="kicker">Before you continue</p>
      <h1 className="font-display mt-3 text-3xl font-medium tracking-tight" style={{ color: "var(--text)" }}>
        Accept the current policies.
      </h1>
      <p className="mt-3 text-sm leading-6" style={{ color: "var(--text-muted)" }}>
        Your account exists, but LOOM needs a recorded acceptance before it can
        write to your chapter. This is stored once per policy version.
      </p>
      <ConsentForm
        termsVersion={POLICY_VERSIONS.terms}
        privacyVersion={POLICY_VERSIONS.privacy}
        next={next}
      />
    </AuthShell>
  );
}
