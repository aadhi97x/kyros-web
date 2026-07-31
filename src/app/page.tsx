import Link from 'next/link';

/**
 * Public landing page. The club owner and venue dashboards live behind
 * /dashboard; the member experience is the mobile app (kyros-app).
 */
export default function HomePage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <p className="text-sm font-medium uppercase tracking-widest text-pitch-600">Kyros</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight">
        Run your club the way you already run it.
      </h1>
      <p className="mt-4 max-w-2xl text-lg text-ink-500">
        Demo sessions, batch placement, waitlists, approvals, part payments and pause rules are all
        settings — not assumptions we make for you. Configure your club once and the member app
        follows your process, not ours.
      </p>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/dashboard"
          className="rounded-lg bg-pitch-600 px-5 py-2.5 font-medium text-white transition hover:bg-pitch-700"
        >
          Club dashboard
        </Link>
        <Link
          href="/api/v1/catalog"
          className="rounded-lg border border-[var(--border)] px-5 py-2.5 font-medium transition hover:bg-[var(--surface)]"
        >
          Browse the catalog API
        </Link>
      </div>

      <section className="mt-16 grid gap-4 sm:grid-cols-2">
        {[
          {
            title: 'Configuration over assumption',
            body: 'Twelve toggles decide how members join, pay, pause and cancel. The member app branches on them at runtime.',
          },
          {
            title: 'Mode lives on the batch',
            body: 'Run a monthly academy batch and a pay-per-session credits batch side by side in the same club.',
          },
          {
            title: 'Attendance that works offline',
            body: 'Coaches mark a roster with no signal. The queue syncs when connectivity returns, and replays are safe.',
          },
          {
            title: 'Consent built in, not bolted on',
            body: 'Structured, per-purpose, withdrawable consent records for every minor, with verifiable parent identity.',
          },
        ].map((item) => (
          <article key={item.title} className="card p-5">
            <h2 className="font-semibold">{item.title}</h2>
            <p className="mt-2 text-sm text-ink-500">{item.body}</p>
          </article>
        ))}
      </section>

      <footer className="mt-16 border-t border-[var(--border)] pt-6 text-sm text-ink-500">
        Member and coach apps ship separately — see the <code>kyros-app</code> repository.
      </footer>
    </main>
  );
}
