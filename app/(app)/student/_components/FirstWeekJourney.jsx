import Link from "next/link";

export function FirstWeekJourney({
  domain,
  verifiedCount = 0,
  githubConnected = false,
  projectCount = 0,
  nextNode
}) {
  const steps = [
    {
      key: "direction",
      title: "Set your direction",
      body: "Choose a track so milestones, people, and projects point the right way.",
      done: Boolean(domain),
      href: "/student/onboarding",
      action: domain ? "Review track" : "Choose a track"
    },
    {
      key: "first-node",
      title: "Finish your first milestone",
      body: "Complete one roadmap node. Verified work unlocks the next milestone.",
      done: verifiedCount > 0,
      href: nextNode?.id ? `/student/roadmap/${nextNode.id}` : "/student/roadmap",
      action: verifiedCount > 0 ? "Keep going" : "Start milestone one"
    },
    {
      key: "github",
      title: "Connect GitHub",
      body: "GitHub confirms your identity and turns real commits into evidence.",
      done: githubConnected,
      href: "/student/github",
      action: githubConnected ? "View connection" : "Connect GitHub"
    },
    {
      key: "project",
      title: "Put a project on the board",
      body: "Describe what you are building and link the repository that proves it.",
      done: projectCount > 0,
      href: projectCount > 0 ? "/student/projects" : "/student/projects/new",
      action: projectCount > 0 ? "View projects" : "Add a project"
    }
  ];
  const doneCount = steps.filter((step) => step.done).length;
  const current = steps.find((step) => !step.done);
  const percent = Math.round((doneCount / steps.length) * 100);

  return (
    <section className="desk-section desk-firstweek" aria-labelledby="desk-firstweek-title">
      <div className="desk-section-head">
        <span className="desk-index">00</span>
        <h2 id="desk-firstweek-title">Your first week</h2>
        <span className="desk-note">{doneCount} of {steps.length} done</span>
      </div>
      <p className="desk-section-lede">
        Four real steps, in order. Each one updates from your account — nothing here is a placeholder.
      </p>

      <div className="desk-firstweek-meter" role="img" aria-label={`${percent} percent of your first week complete`}>
        <span style={{ width: `${percent}%` }} />
      </div>

      <ol className="desk-firstweek-list">
        {steps.map((step, index) => {
          const state = step.done ? "done" : current?.key === step.key ? "now" : "todo";
          return (
            <li key={step.key} className={`desk-firstweek-step is-${state}`}>
              <Link href={step.href} prefetch={false}>
                <span className="desk-firstweek-dot" aria-hidden="true">
                  {step.done ? "✓" : String(index + 1).padStart(2, "0")}
                </span>
                <span className="desk-firstweek-copy">
                  <span className="desk-firstweek-title">{step.title}</span>
                  <span className="desk-firstweek-body">{step.body}</span>
                </span>
                <span className="desk-firstweek-action">
                  {step.done ? "Done" : state === "now" ? step.action : "Queued"}
                  {!step.done && <span aria-hidden="true"> →</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>

      {current && (
        <div className="desk-firstweek-cta">
          <p>
            <span className="desk-label">Next</span>
            <strong>{current.title}</strong>
          </p>
          <Link href={current.href} prefetch={false} className="btn-ink !px-5 !py-2.5 text-sm">
            {current.action} →
          </Link>
        </div>
      )}
    </section>
  );
}
