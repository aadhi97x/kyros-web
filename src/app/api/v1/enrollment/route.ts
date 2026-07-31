import { z } from 'zod';
import { created, ok } from '@/lib/api/response';
import { authedRoute, parseBody, parseQuery } from '@/lib/api/handler';
import { assertOwnsPlayerProfile } from '@/lib/auth/rbac';
import { createEnrollment, currentStep } from '@/domain/enrollment/service';
import { projectRemainingSteps } from '@/domain/enrollment/state-machine';
import { buildEnrollmentContext } from '@/domain/enrollment/service';
import { auditContextFrom } from '@/lib/audit';

const querySchema = z.object({
  playerProfileId: z.string().min(1),
  clubId: z.string().min(1),
  batchId: z.string().min(1).optional(),
  packageId: z.string().min(1).optional(),
});

/**
 * GET /api/v1/enrollment?playerProfileId=&clubId=&batchId=&packageId=
 *
 * Spec 2.7: the member app renders whatever step comes back. It must NOT infer
 * the next screen itself — that is what makes the flow config-driven rather
 * than a hardcoded wizard.
 */
export const GET = authedRoute(async ({ request, actor }) => {
  const query = parseQuery(request, querySchema);
  await assertOwnsPlayerProfile(actor, query.playerProfileId);

  const context = await buildEnrollmentContext(query);
  const decision = await currentStep(query);

  return ok({
    ...decision,
    // Spec 2.6: the "what happens next" timeline, derived from this club's
    // config so it never promises a step the club has switched off.
    remainingSteps: projectRemainingSteps(context.config, decision.step),
  });
});

const createSchema = z.object({
  playerProfileId: z.string().min(1),
  clubId: z.string().min(1),
  batchId: z.string().min(1),
  packageId: z.string().min(1),
  selectedAddOnNames: z.array(z.string().max(100)).max(20).default([]),
  applyWalletCredit: z.boolean().default(false),
  usePartPayment: z.boolean().default(false),
});

/**
 * POST /api/v1/enrollment
 *
 * Creates the membership and its payment schedule. The state machine's action
 * guard runs server-side first, so a client that skips a gate is rejected.
 */
export const POST = authedRoute(async ({ request, actor }) => {
  const body = await parseBody(request, createSchema);
  const context = auditContextFrom(request);

  await assertOwnsPlayerProfile(actor, body.playerProfileId);

  const result = await createEnrollment({
    ...body,
    accountId: actor.accountId,
    context,
  });

  return created(result);
});
