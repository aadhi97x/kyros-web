import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  __testing,
  createPkcePair,
  createStateToken,
  defaultVerifier,
  getVerifier,
  VerificationError,
  type CompleteContext,
  type StartContext,
} from '@/domain/consent/verification';
import { resetEnvCache } from '@/lib/env';

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://kyros:kyros@localhost:5432/kyros_test',
  JWT_SECRET: 'a-test-secret-that-is-comfortably-over-32-characters',
};

function setEnv(extra: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...extra })) {
    vi.stubEnv(key, value);
  }
  resetEnvCache();
}

function startContext(over: Partial<StartContext> = {}): StartContext {
  return {
    requestId: 'req_1',
    accountId: 'acc_1',
    playerProfileId: 'player_1',
    stateToken: 'state_1',
    expiresAt: new Date(Date.now() + 900_000),
    ...over,
  };
}

function completeContext(over: Partial<CompleteContext> = {}): CompleteContext {
  return {
    requestId: 'req_1',
    accountId: 'acc_1',
    payload: {},
    ...over,
  };
}

beforeEach(() => setEnv());

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvCache();
});

describe('PKCE', () => {
  it('produces a verifier and a matching S256 challenge', () => {
    const { verifier, challenge } = createPkcePair();
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('produces URL-safe values with no padding', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { verifier, challenge } = createPkcePair();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('meets RFC 7636’s 43–128 character length requirement', () => {
    const { verifier } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('never repeats a verifier', () => {
    const seen = new Set(Array.from({ length: 200 }, () => createPkcePair().verifier));
    expect(seen.size).toBe(200);
  });

  it('generates unguessable state tokens', () => {
    const seen = new Set(Array.from({ length: 200 }, () => createStateToken()));
    expect(seen.size).toBe(200);
    expect(createStateToken().length).toBeGreaterThanOrEqual(40);
  });
});

describe('opaque references', () => {
  const { opaqueReference } = __testing;

  it('is deterministic for the same subject', () => {
    expect(opaqueReference('DIGILOCKER', 'subject-123')).toBe(
      opaqueReference('DIGILOCKER', 'subject-123'),
    );
  });

  it('differs across subjects and across methods', () => {
    expect(opaqueReference('DIGILOCKER', 'a')).not.toBe(opaqueReference('DIGILOCKER', 'b'));
    expect(opaqueReference('DIGILOCKER', 'a')).not.toBe(opaqueReference('MOCK', 'a'));
  });

  it('does not contain the subject — a leaked audit row must reveal nothing', () => {
    const identityNumber = '123456789012';
    const reference = opaqueReference('DIGILOCKER', identityNumber);
    expect(reference).not.toContain(identityNumber);
    expect(reference).toMatch(/^digilocker_[0-9a-f]{32}$/);
  });
});

describe('name matching', () => {
  const { normaliseName, namesPlausiblyMatch } = __testing;

  it('strips honorifics, punctuation and case', () => {
    expect(normaliseName('Mrs. Priya  Sharma')).toBe('priya sharma');
    expect(normaliseName('SHRI Ravi Menon')).toBe('ravi menon');
  });

  it('matches on a shared substantive token', () => {
    expect(namesPlausiblyMatch('Priya Sharma', 'Priya R Sharma')).toBe(true);
    expect(namesPlausiblyMatch('Ravi Menon', 'Menon Ravi')).toBe(true);
  });

  it('does not match unrelated names', () => {
    expect(namesPlausiblyMatch('Priya Sharma', 'Anjali Nair')).toBe(false);
  });

  it('ignores short tokens like initials, which would match almost anything', () => {
    expect(namesPlausiblyMatch('A B Kumar', 'A B Nair')).toBe(false);
  });
});

describe('mock verifier', () => {
  it('is the default when CONSENT_VERIFIER is not digilocker', () => {
    expect(defaultVerifier().method).toBe('MOCK');
  });

  it('is not a redirect flow', () => {
    expect(getVerifier('MOCK').isRedirectFlow).toBe(false);
  });

  it('returns an instruction rather than a URL', async () => {
    const started = await getVerifier('MOCK').start(startContext());
    expect(started.redirectUrl).toBeUndefined();
    expect(started.instruction).toMatch(/confirm/i);
    expect(started.requestId).toBe('req_1');
  });

  it('refuses without an explicit confirmation', async () => {
    await expect(getVerifier('MOCK').complete(completeContext())).rejects.toThrow(VerificationError);
  });

  it('verifies when confirmed, and marks itself as not a real check', async () => {
    const result = await getVerifier('MOCK').complete(
      completeContext({ payload: { confirm: true } }),
    );
    expect(result.verified).toBe(true);
    expect(result.reference).toMatch(/^mock_/);
    expect(result.note).toMatch(/not a real identity check/i);
  });
});

describe('manual offline verifier', () => {
  const verifier = getVerifier('MANUAL_OFFLINE');

  it('demands to know which staff member performed the check', async () => {
    await expect(
      verifier.complete(completeContext({ payload: { documentType: 'voter ID' } })),
    ).rejects.toThrow(/which staff account/i);
  });

  it('demands to know what kind of document was seen', async () => {
    await expect(
      verifier.complete(completeContext({ payload: { verifiedByAccountId: 'staff_1' } })),
    ).rejects.toThrow(/which type of identification/i);
  });

  it('records the accountability trail without storing the document itself', async () => {
    const result = await verifier.complete(
      completeContext({ payload: { verifiedByAccountId: 'staff_1', documentType: 'voter ID' } }),
    );
    expect(result.verified).toBe(true);
    expect(result.note).toContain('staff_1');
    expect(result.note).toContain('voter ID');
  });
});

describe('digilocker verifier', () => {
  const DIGILOCKER_ENV = {
    CONSENT_VERIFIER: 'digilocker',
    DIGILOCKER_CLIENT_ID: 'test-client',
    DIGILOCKER_CLIENT_SECRET: 'test-secret',
    DIGILOCKER_REDIRECT_URI: 'https://kyros.test/api/v1/consent/digilocker/callback',
  };

  const verifier = getVerifier('DIGILOCKER');

  function mockTokenResponse(body: unknown, status = 200) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  }

  describe('starting the flow', () => {
    it('refuses when the deployment is not configured', async () => {
      setEnv({ CONSENT_VERIFIER: 'digilocker' });
      await expect(
        verifier.start(startContext({ codeChallenge: 'challenge' })),
      ).rejects.toThrow(/not configured/i);
    });

    it('refuses without a PKCE challenge', async () => {
      setEnv(DIGILOCKER_ENV);
      await expect(verifier.start(startContext())).rejects.toThrow(/PKCE/i);
    });

    it('builds an authorize URL carrying the challenge and state', async () => {
      setEnv(DIGILOCKER_ENV);
      const started = await verifier.start(
        startContext({ codeChallenge: 'the-challenge', stateToken: 'the-state' }),
      );

      const url = new URL(started.redirectUrl!);
      expect(url.origin + url.pathname).toBe(
        'https://api.digitallocker.gov.in/public/oauth2/1/authorize',
      );
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('test-client');
      expect(url.searchParams.get('code_challenge')).toBe('the-challenge');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('state')).toBe('the-state');
    });

    it('requests only basic_profile — we do not need document contents', async () => {
      setEnv(DIGILOCKER_ENV);
      const started = await verifier.start(startContext({ codeChallenge: 'c' }));
      expect(new URL(started.redirectUrl!).searchParams.get('scope')).toBe('basic_profile');
    });

    it('honours an overridden endpoint so the sandbox needs no code change', async () => {
      setEnv({
        ...DIGILOCKER_ENV,
        DIGILOCKER_AUTHORIZE_URL: 'https://sandbox.example.gov.in/oauth2/1/authorize',
      });
      const started = await verifier.start(startContext({ codeChallenge: 'c' }));
      expect(started.redirectUrl).toContain('sandbox.example.gov.in');
    });
  });

  describe('completing the flow', () => {
    beforeEach(() => setEnv(DIGILOCKER_ENV));

    it('refuses without an authorisation code', async () => {
      await expect(
        verifier.complete(completeContext({ codeVerifier: 'v' })),
      ).rejects.toThrow(/authorisation code/i);
    });

    it('refuses without the stored PKCE verifier', async () => {
      await expect(
        verifier.complete(completeContext({ payload: { code: 'abc' } })),
      ).rejects.toThrow(/PKCE verifier/i);
    });

    it('posts a form-encoded exchange including the code verifier', async () => {
      mockTokenResponse({ access_token: 'tok', digilockerid: 'dl-subject-1', eaadhaar: 'Y' });

      await verifier.complete(
        completeContext({ payload: { code: 'the-code' }, codeVerifier: 'the-verifier' }),
      );

      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

      expect(url).toBe('https://api.digitallocker.gov.in/public/oauth2/1/token');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['content-type']).toBe(
        'application/x-www-form-urlencoded',
      );

      const body = new URLSearchParams(init.body as string);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('the-code');
      expect(body.get('code_verifier')).toBe('the-verifier');
      expect(body.get('client_secret')).toBe('test-secret');
    });

    it('hashes digilockerid into an opaque reference', async () => {
      mockTokenResponse({ access_token: 'tok', digilockerid: 'dl-subject-1' });

      const result = await verifier.complete(
        completeContext({ payload: { code: 'c' }, codeVerifier: 'v' }),
      );

      expect(result.verified).toBe(true);
      expect(result.reference).toMatch(/^digilocker_[0-9a-f]{32}$/);
      expect(result.reference).not.toContain('dl-subject-1');
    });

    it('never returns the parent’s name, DOB or gender', async () => {
      mockTokenResponse({
        access_token: 'tok',
        digilockerid: 'dl-1',
        name: 'Priya Sharma',
        dob: '01-01-1985',
        gender: 'F',
      });

      const result = await verifier.complete(
        completeContext({ payload: { code: 'c' }, codeVerifier: 'v', accountName: 'Priya Sharma' }),
      );

      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain('Priya');
      expect(serialised).not.toContain('01-01-1985');
      expect(serialised).not.toContain('"F"');
    });

    it('records whether the name matched the account holder', async () => {
      mockTokenResponse({ access_token: 'tok', digilockerid: 'dl-1', name: 'Priya Sharma' });
      const matched = await verifier.complete(
        completeContext({ payload: { code: 'c' }, codeVerifier: 'v', accountName: 'Priya R Sharma' }),
      );
      expect(matched.note).toMatch(/name matched/i);

      mockTokenResponse({ access_token: 'tok', digilockerid: 'dl-1', name: 'Someone Else' });
      const mismatched = await verifier.complete(
        completeContext({ payload: { code: 'c' }, codeVerifier: 'v', accountName: 'Priya Sharma' }),
      );
      expect(mismatched.note).toMatch(/did NOT match/i);
    });

    it('records whether the account is Aadhaar-seeded', async () => {
      mockTokenResponse({ access_token: 'tok', digilockerid: 'dl-1', eaadhaar: 'Y' });
      const seeded = await verifier.complete(
        completeContext({ payload: { code: 'c' }, codeVerifier: 'v' }),
      );
      expect(seeded.note).toMatch(/Aadhaar-seeded/);

      mockTokenResponse({ access_token: 'tok', digilockerid: 'dl-1', eaadhaar: 'N' });
      const notSeeded = await verifier.complete(
        completeContext({ payload: { code: 'c' }, codeVerifier: 'v' }),
      );
      expect(notSeeded.note).toMatch(/not Aadhaar-seeded/);
    });

    it('surfaces a provider rejection', async () => {
      mockTokenResponse(
        { error: 'invalid_grant', error_description: 'Authorisation code has expired.' },
        400,
      );
      await expect(
        verifier.complete(completeContext({ payload: { code: 'c' }, codeVerifier: 'v' })),
      ).rejects.toThrow(/Authorisation code has expired/);
    });

    it('marks a 5xx as retryable but a 4xx as not', async () => {
      mockTokenResponse({ error: 'server_error' }, 503);
      await expect(
        verifier.complete(completeContext({ payload: { code: 'c' }, codeVerifier: 'v' })),
      ).rejects.toMatchObject({ retryable: true });

      mockTokenResponse({ error: 'invalid_grant' }, 400);
      await expect(
        verifier.complete(completeContext({ payload: { code: 'c' }, codeVerifier: 'v' })),
      ).rejects.toMatchObject({ retryable: false });
    });

    it('fails loudly when the response has no subject identifier', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockTokenResponse({ access_token: 'tok', name: 'Priya Sharma' });

      await expect(
        verifier.complete(completeContext({ payload: { code: 'c' }, codeVerifier: 'v' })),
      ).rejects.toThrow(/did not return an account identifier/i);

      // The diagnostic must name the KEYS, never the values — those are the
      // parent's identity data.
      const logged = consoleError.mock.calls.flat().join(' ');
      expect(logged).toContain('access_token');
      expect(logged).not.toContain('Priya');
    });

    it('reports a network failure as retryable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('ECONNRESET');
        }),
      );
      await expect(
        verifier.complete(completeContext({ payload: { code: 'c' }, codeVerifier: 'v' })),
      ).rejects.toMatchObject({ retryable: true });
    });

    it('reports a non-JSON response rather than crashing', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('<html>Gateway Timeout</html>', { status: 504 })),
      );
      await expect(
        verifier.complete(completeContext({ payload: { code: 'c' }, codeVerifier: 'v' })),
      ).rejects.toThrow(/non-JSON/i);
    });
  });
});
