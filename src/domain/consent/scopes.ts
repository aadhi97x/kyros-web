/**
 * Consent scopes and the plain-language notice.
 *
 * Spec 2.3: consent must be "specific, informed, unbundled and affirmative —
 * a plain-language explanation of what is collected and why, agreed to
 * separately. It must NOT be buried in the privacy policy or implied by the act
 * of enrolling."
 *
 * Two consequences shape this file:
 *   1. Consent is per-PURPOSE, not one blob. The parent ticks each purpose.
 *   2. The exact notice text and its version are stored on the consent record,
 *      so we can prove later what was actually shown.
 *
 * Pure module: no I/O.
 */

export const CONSENT_NOTICE_VERSION = '2026-01-15.v1';

export const consentScopes = [
  'ENROLLMENT_ADMIN',
  'ATTENDANCE_RECORDS',
  'COACH_ASSESSMENTS',
  'MEDICAL_EMERGENCY',
  'PHOTOS_INTERNAL',
  'PHOTOS_MARKETING',
  'BATCH_CHAT',
] as const;

export type ConsentScope = (typeof consentScopes)[number];

export interface ConsentScopeDefinition {
  scope: ConsentScope;
  label: string;
  /** What is collected and why, in the words a parent would use. */
  explanation: string;
  /**
   * Required scopes are the ones without which the service genuinely cannot be
   * delivered. Everything else must be declinable — DPDP does not permit
   * bundling optional processing into the price of admission.
   */
  required: boolean;
  dataCollected: string[];
  retention: string;
}

export const CONSENT_SCOPE_DEFINITIONS: ConsentScopeDefinition[] = [
  {
    scope: 'ENROLLMENT_ADMIN',
    label: 'Enrolling and managing your child’s membership',
    explanation:
      'We store your child’s name, date of birth and the batch they join so the club knows who is training, when, and under which coach. Without this we cannot enroll them.',
    required: true,
    dataCollected: ['Full name', 'Date of birth', 'Gender (if you provide it)', 'Batch and schedule'],
    retention: 'For as long as the membership is active, then up to 36 months.',
  },
  {
    scope: 'ATTENDANCE_RECORDS',
    label: 'Recording attendance at sessions',
    explanation:
      'The coach marks your child present, absent or late at each session. This lets you see their attendance history and lets the club follow up if they stop coming.',
    required: true,
    dataCollected: ['Session date and time', 'Present / absent / late', 'Which coach marked it'],
    retention: 'Up to 36 months after the membership ends.',
  },
  {
    scope: 'COACH_ASSESSMENTS',
    label: 'Coach feedback and skill ratings',
    explanation:
      'Coaches record notes and skill ratings so you can see how your child is progressing and so periodic reports can be produced. These are assessments of football skill — we do not analyse behaviour or build a profile of your child.',
    required: false,
    dataCollected: ['Skill ratings', 'Coach notes', 'Periodic performance reports'],
    retention: 'Up to 36 months after the membership ends.',
  },
  {
    scope: 'MEDICAL_EMERGENCY',
    label: 'Medical notes and emergency contact',
    explanation:
      'Allergies, conditions and an emergency contact, so a coach can act correctly if your child is hurt or unwell at training. Visible only to coaches at your club.',
    required: false,
    dataCollected: ['Medical notes and allergies', 'Emergency contact name and number'],
    retention: 'Deleted when the membership ends.',
  },
  {
    scope: 'PHOTOS_INTERNAL',
    label: 'A profile photo, visible inside the club',
    explanation:
      'A photo on your child’s profile so coaches can identify them on the pitch. Shown only to that club’s coaches and staff.',
    required: false,
    dataCollected: ['Profile photograph'],
    retention: 'Deleted when the membership ends or when you withdraw this consent.',
  },
  {
    scope: 'PHOTOS_MARKETING',
    label: 'Photos in club promotion',
    explanation:
      'Photos or video from sessions and matches used on the club’s page, social media or promotional material. This is entirely optional and refusing it changes nothing about your child’s training.',
    required: false,
    dataCollected: ['Photographs and video from sessions and events'],
    retention: 'Until you withdraw this consent.',
  },
  {
    scope: 'BATCH_CHAT',
    label: 'Batch group chat',
    explanation:
      'Your name appears in the batch group chat alongside the coach and other parents, so the club can share schedule changes and updates. Messages are between adults — your child does not get a login.',
    required: false,
    dataCollected: ['Your display name', 'Messages you send'],
    retention: 'Until you leave the batch.',
  },
];

const DEFINITIONS_BY_SCOPE = new Map(
  CONSENT_SCOPE_DEFINITIONS.map((definition) => [definition.scope, definition]),
);

export function scopeDefinition(scope: ConsentScope): ConsentScopeDefinition {
  const definition = DEFINITIONS_BY_SCOPE.get(scope);
  if (!definition) throw new Error(`Unknown consent scope: ${scope}`);
  return definition;
}

export function requiredScopes(): ConsentScope[] {
  return CONSENT_SCOPE_DEFINITIONS.filter((definition) => definition.required).map((d) => d.scope);
}

export function optionalScopes(): ConsentScope[] {
  return CONSENT_SCOPE_DEFINITIONS.filter((definition) => !definition.required).map((d) => d.scope);
}

export function isConsentScope(value: string): value is ConsentScope {
  return (consentScopes as readonly string[]).includes(value);
}

/**
 * A consent grant is only valid if it covers every required scope. Optional
 * scopes may be freely declined — that is the "unbundled" requirement.
 */
export function validateScopeSelection(selected: ConsentScope[]): {
  ok: boolean;
  missing: ConsentScope[];
} {
  const chosen = new Set(selected);
  const missing = requiredScopes().filter((scope) => !chosen.has(scope));
  return { ok: missing.length === 0, missing };
}

/**
 * The exact text stored on the consent record. Rendering this from the
 * definitions — rather than storing a hand-written paragraph — guarantees the
 * stored notice matches what the screen showed.
 */
export function renderNotice(selected: ConsentScope[]): string {
  const lines: string[] = [
    'Consent to process your child’s personal data',
    '',
    'Kyros is the platform your football club uses to run its academy. The club is responsible for your child’s data; Kyros processes it on the club’s behalf.',
    '',
    'You are agreeing to the following, and only the following:',
    '',
  ];

  for (const scope of selected) {
    const definition = scopeDefinition(scope);
    lines.push(`• ${definition.label}${definition.required ? ' (required)' : ' (optional)'}`);
    lines.push(`  ${definition.explanation}`);
    lines.push(`  Data: ${definition.dataCollected.join(', ')}.`);
    lines.push(`  Kept: ${definition.retention}`);
    lines.push('');
  }

  lines.push(
    'You can withdraw any of these at any time from Settings → Consent. Withdrawing a required consent ends the membership; withdrawing an optional one changes nothing else.',
    '',
    'We do not profile your child, track their behaviour, or show them advertising. We do not sell data to anyone.',
    '',
    `Notice version ${CONSENT_NOTICE_VERSION}.`,
  );

  return lines.join('\n');
}
