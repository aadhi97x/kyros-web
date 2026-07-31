import Link from 'next/link';
import { prisma } from '@/lib/db';
import { describeConfig, parseClubConfigSafe } from '@/domain/config/engine';
import { formatInr } from '@/domain/money/pricing';

export const dynamic = 'force-dynamic';

/**
 * Owner dashboard (spec 3.5): cross-centre overview with alert cards for
 * pending demos, waitlists filling up and overdue payments.
 *
 * Rendered server-side straight from the database. Session-scoped auth for the
 * web dashboard is the next step; today it shows every club, which is fine for
 * a single-tenant development environment and must be gated before deploy.
 */
export default async function DashboardPage() {
  const clubs = await prisma.club.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      centres: { where: { isActive: true }, select: { id: true, name: true, city: true } },
      coaches: { where: { isActive: true }, select: { id: true } },
      batches: {
        where: { isActive: true },
        select: { id: true, name: true, capacity: true, activeCount: true, mode: true, type: true },
      },
      demoBookings: { where: { status: { in: ['REQUESTED', 'CONFIRMED'] } }, select: { id: true } },
    },
  });

  const [activeMemberships, overdueInstalments, revenueAgg, waitlistCount] = await Promise.all([
    prisma.membership.count({ where: { status: 'ACTIVE' } }),
    prisma.instalment.count({ where: { paidAt: null, dueDate: { lt: new Date() } } }),
    prisma.payment.aggregate({ where: { status: 'SUCCEEDED' }, _sum: { amountPaise: true } }),
    prisma.waitlistEntry.count({ where: { removedAt: null, promotedAt: null } }),
  ]);

  const pendingDemos = clubs.reduce((sum, club) => sum + club.demoBookings.length, 0);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-sm font-medium uppercase tracking-widest text-pitch-600">Kyros</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Owner dashboard</h1>
        </div>
        <Link href="/" className="text-sm text-ink-500 underline">
          Back to site
        </Link>
      </header>

      <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Active members" value={String(activeMemberships)} />
        <Stat label="Revenue collected" value={formatInr(revenueAgg._sum.amountPaise ?? 0)} />
        <Stat
          label="Pending demos"
          value={String(pendingDemos)}
          tone={pendingDemos > 0 ? 'warn' : 'plain'}
        />
        <Stat
          label="Overdue instalments"
          value={String(overdueInstalments)}
          tone={overdueInstalments > 0 ? 'alert' : 'plain'}
        />
      </section>

      {waitlistCount > 0 && (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {waitlistCount} member{waitlistCount === 1 ? ' is' : 's are'} waiting for a place. Promote
          them as soon as a batch frees up.
        </p>
      )}

      <h2 className="mt-12 text-xl font-semibold">Clubs</h2>

      <div className="mt-4 space-y-6">
        {clubs.length === 0 && (
          <p className="text-ink-500">
            No clubs yet. Run <code>npm run db:seed</code> to load demo data.
          </p>
        )}

        {clubs.map((club) => {
          const { config, ok } = parseClubConfigSafe(club.config);
          const totalCapacity = club.batches.reduce((sum, batch) => sum + batch.capacity, 0);
          const totalClaimed = club.batches.reduce((sum, batch) => sum + batch.activeCount, 0);

          return (
            <article key={club.id} className="card p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold">{club.name}</h3>
                  <p className="mt-0.5 text-sm text-ink-500">
                    {club.centres.map((centre) => `${centre.name}, ${centre.city}`).join(' · ') ||
                      'No centres yet'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {!ok && (
                    <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-800">
                      Config invalid — using defaults
                    </span>
                  )}
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      club.status === 'PUBLISHED'
                        ? 'bg-pitch-100 text-pitch-700'
                        : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {club.status}
                  </span>
                </div>
              </div>

              <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-4">
                <Meta label="Centres" value={String(club.centres.length)} />
                <Meta label="Coaches" value={String(club.coaches.length)} />
                <Meta label="Batches" value={String(club.batches.length)} />
                <Meta label="Places filled" value={`${totalClaimed} / ${totalCapacity}`} />
              </dl>

              {club.batches.length > 0 && (
                <div className="mt-5 overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-left text-sm">
                    <thead className="text-xs uppercase tracking-wide text-ink-500">
                      <tr>
                        <th className="pb-2 font-medium">Batch</th>
                        <th className="pb-2 font-medium">Mode</th>
                        <th className="pb-2 font-medium">Type</th>
                        <th className="pb-2 font-medium">Filled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {club.batches.map((batch) => {
                        const full = batch.activeCount >= batch.capacity;
                        return (
                          <tr key={batch.id} className="border-t border-[var(--border)]">
                            <td className="py-2">{batch.name}</td>
                            <td className="py-2 text-ink-500">{batch.mode}</td>
                            <td className="py-2 text-ink-500">{batch.type}</td>
                            <td className={`py-2 ${full ? 'font-medium text-amber-700' : ''}`}>
                              {batch.activeCount} / {batch.capacity}
                              {full && ' · full'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Spec 3.1 step 10: the review screen states the club's rules in
                  plain language, generated from the config itself. */}
              <details className="mt-5">
                <summary className="cursor-pointer text-sm font-medium text-pitch-600">
                  How this club operates
                </summary>
                <ul className="mt-3 space-y-1.5 text-sm text-ink-500">
                  {describeConfig(config).map((line) => (
                    <li key={line}>• {line}</li>
                  ))}
                </ul>
              </details>
            </article>
          );
        })}
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  tone = 'plain',
}: {
  label: string;
  value: string;
  tone?: 'plain' | 'warn' | 'alert';
}) {
  const toneClass =
    tone === 'alert'
      ? 'text-red-700'
      : tone === 'warn'
        ? 'text-amber-700'
        : '';

  return (
    <div className="card p-5">
      <p className="text-xs uppercase tracking-wide text-ink-500">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}
