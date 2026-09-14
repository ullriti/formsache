import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OIDC_BUTTON_LABEL,
  DEFAULT_OIDC_EMAIL_CLAIM,
  DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
  type OidcProvider,
} from '@formsache/shared';

import type { PublicUrlService } from '../../common/public-url/public-url.service';
import type { ApiEnv } from '@formsache/shared';
import { SecretBoxService } from '../../common/secret-box/secret-box.service';
import { OidcConfigService } from '../../tenant-admin/oidc-config.service';
import { OidcSecretsService } from '../../tenant-admin/oidc-secrets.service';
import type { SessionService } from '../session.service';
import type { OidcIdentityService } from './oidc-identity.service';
import { OidcLoginService } from './oidc-login.service';
import type { OidcProviderService } from './oidc-provider.service';
import type {
  OfferableTenant,
  OidcTenantsService,
} from './oidc-tenants.service';

/**
 * **What the unauthenticated offer route may and may not do** (review finding) — and the drift guard for the price that closing it cost.
 *
 * `GET /api/auth/oidc/providers` is reachable without a session. It used to
 * call `OidcConfigService.signIn(row)` per enabled Organisation, which returns an
 * `OidcSignIn` **carrying the client secret in clear**, and read one field off
 * it: the button caption. Whether that plaintext ever left the server was
 * therefore a question about the shape of `OidcProvider` rather than about the
 * shape of the code — one widened response away from a leak, on the one route a
 * stranger may call thirty times a minute.
 *
 * Two things are asserted here, and they belong together:
 *
 * 1. **The offer route builds no `OidcSignIn`.** That is the falsifiable form
 *    of “unseals nothing”: `signIn` is the only method that hands a plaintext
 *    client secret to this package, and the spy sees every call to it. Revert
 *    the fix and the third test goes red.
 * 2. **The offer route and `signIn` agree, row by row.** Answering without the
 *    secret means restating the four conditions above it, and a second copy of
 *    a rule is exactly what a review objects to elsewhere. So the copies are
 *    not trusted: both run over the same table of rows and must give the same
 *    verdict for each. Drop the `openid` check on one side, forget
 *    `oidcEnabled`, stop normalising the issuer — and the comparison names the
 *    row that disagrees.
 *
 * ## What this file deliberately does **not** claim
 *
 * Not “`SecretBoxService.open` is never called”. It still is, once per organisation
 * that is otherwise fully configured, inside `OidcSecretsService.isUsable` —
 * which is implemented as open-and-discard, because `tenant-admin` offers no
 * predicate that verifies the GCM tag without materialising the plaintext. The
 * last test **counts** that call rather than forbidding it, so the residual is
 * visible in a test instead of in prose that rots. What changed is that the
 * plaintext is created and dropped one statement wide inside `tenant-admin` and
 * no longer crosses into the login package; removing it altogether is a change
 * in `tenant-admin/**` (ADR-0012 no. 7, Folgearbeit).
 */

/** 32 bytes, fixed: this is a test key and there is nothing to protect. */
const TEST_KEY = Buffer.alloc(32, 11);

const ALPHA = '019ff500-0000-7000-8000-0000000000a1';
const BETA = '019ff500-0000-7000-8000-0000000000b2';

const ISSUER = 'https://idp.alpha.invalid/realms/demo';
const REDIRECT_URI = 'https://formulare.demo.invalid/api/auth/oidc/callback';

/** Seals a value the way `PUT /api/tenant/oidc` seals it, for one organisation. */
function sealedFor(tenantId: string): Uint8Array<ArrayBuffer> {
  return new OidcSecretsService(new SecretBoxService(TEST_KEY)).seal(
    'client-secret-of-alpha',
    tenantId,
  );
}

function offerable(overrides: Partial<OfferableTenant> = {}): OfferableTenant {
  return {
    id: ALPHA,
    name: 'Verein Alpha',
    shortName: 'Alpha',
    oidcEnabled: true,
    oidcIssuer: ISSUER,
    oidcClientId: 'formular-alpha',
    oidcClientSecret: sealedFor(ALPHA),
    oidcScopes: ['openid', 'email'],
    oidcEmailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
    oidcEmailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
    oidcButtonLabel: 'Mit Alpha-Konto anmelden',
    publicBaseUrl: null,
    ...overrides,
  };
}

/**
 * A real {@link SecretBoxService}, a real {@link OidcSecretsService} and a real
 * {@link OidcConfigService}, with the spies **on top of the real
 * implementations** — the shape of `settings/access-word.service.spec.ts`, and
 * for its reason: a stub that answered a constant would make “opens nothing”
 * unfalsifiable.
 *
 * The three collaborators the offer route never reaches are empty objects
 * rather than mocks, so a route that started calling one would fail loudly
 * instead of silently passing.
 */
function harness(rows: readonly OfferableTenant[]) {
  const box = new SecretBoxService(TEST_KEY);
  const secrets = new OidcSecretsService(box);
  const config = new OidcConfigService(
    secrets,
    {
      // Asynchronous: the base address is a row, not an environment
      // variable, so the whole of `PublicUrlService` answers promises.
      oidcCallbackUrl: () => Promise.resolve(REDIRECT_URI),
    } as unknown as PublicUrlService,
    // A review finding: the operator's allowlist, empty here — so “every public
    // host”, the default.
    { OIDC_ISSUER_ALLOWLIST: undefined } as unknown as ApiEnv,
  );

  const login = new OidcLoginService(
    { findOfferable: () => Promise.resolve(rows) } as OidcTenantsService,
    config,
    secrets,
    {} as OidcProviderService,
    {} as OidcIdentityService,
    {} as SessionService,
    { OIDC_ISSUER_ALLOWLIST: undefined } as unknown as ApiEnv,
  );

  return {
    login,
    config,
    signIn: vi.spyOn(config, 'signIn'),
    open: vi.spyOn(box, 'open'),
  };
}

/**
 * Every shape the offer decision can be handed, named after what is wrong with
 * it. A case that existed on only one side of the comparison below would prove
 * nothing about the other, so there is one list.
 */
const ROW_CASES: readonly {
  readonly name: string;
  readonly row: OfferableTenant;
}[] = [
  { name: 'fully configured', row: offerable() },
  { name: 'switched off', row: offerable({ oidcEnabled: false }) },
  { name: 'no issuer', row: offerable({ oidcIssuer: null }) },
  {
    // A value that never passed the write gate because somebody edited the
    // column — `acceptableIssuer` refuses it on the way out as well.
    name: 'an issuer that is not an acceptable discovery base',
    row: offerable({ oidcIssuer: 'javascript:alert(1)' }),
  },
  {
    name: 'an http issuer on a routable host',
    row: offerable({ oidcIssuer: 'http://idp.alpha.invalid' }),
  },
  { name: 'no client id', row: offerable({ oidcClientId: null }) },
  { name: 'no client secret', row: offerable({ oidcClientSecret: null }) },
  {
    name: 'scopes without openid',
    row: offerable({ oidcScopes: ['email', 'profile'] }),
  },
  { name: 'no scopes at all', row: offerable({ oidcScopes: [] }) },
  {
    // the evidence: sealed for BETA, stored in ALPHA's column.
    // “Switched on” and “usable” are different, and fail closed wins.
    name: 'a secret sealed for a different Organisation',
    row: offerable({ oidcClientSecret: sealedFor(BETA) }),
  },
  {
    name: 'bytes that are not a sealed value at all',
    row: offerable({
      oidcClientSecret: new TextEncoder().encode('plaintext-in-the-column'),
    }),
  },
];

describe('the offer route holds no client secret', () => {
  it('answers with the organisation, the names and the caption', async () => {
    const h = harness([offerable()]);

    const expected: OidcProvider[] = [
      {
        tenantId: ALPHA,
        name: 'Verein Alpha',
        shortName: 'Alpha',
        buttonLabel: 'Mit Alpha-Konto anmelden',
        atThisAddress: false,
      },
    ];
    await expect(h.login.offers(null)).resolves.toStrictEqual(expected);
  });

  it('falls back to the shipped caption when the organisation set none', async () => {
    const h = harness([offerable({ oidcButtonLabel: null })]);

    const [offer] = await h.login.offers(null);
    expect(offer?.buttonLabel).toBe(DEFAULT_OIDC_BUTTON_LABEL);
  });

  /**
   * **Which organisation belongs to the address in the browser's bar.**
   *
   * The chooser of the sign-in page pre-selects it, so that an installation
   * serving several organisations under their own addresses does not ask a
   * question it can answer itself. Compared is the `host` — name including
   * port — of `tenant.public_base_url` against the host the request arrived
   * under.
   */
  it('marks the organisation whose base address matches the request host', async () => {
    const h = harness([
      offerable({ publicBaseUrl: 'https://formulare.alpha.example' }),
      offerable({
        id: BETA,
        name: 'Verein Beta',
        shortName: 'Beta',
        oidcClientSecret: sealedFor(BETA),
        publicBaseUrl: 'https://formulare.beta.example',
      }),
    ]);

    const offers = await h.login.offers('formulare.beta.example');

    expect(offers.find((one) => one.atThisAddress)?.tenantId).toBe(BETA);
    expect(offers.filter((one) => one.atThisAddress)).toHaveLength(1);
  });

  /**
   * **Two matches are no match.** `tenant.public_base_url` carries no unique
   * index, two organisations may hold the same address — and "which of the
   * two" is then unanswerable. A guessed pre-selection would be worse than
   * none: it would look like a statement of fact.
   */
  it('marks nobody when two organisations share the address', async () => {
    const h = harness([
      offerable({ publicBaseUrl: 'https://gemeinsam.example' }),
      offerable({
        id: BETA,
        name: 'Verein Beta',
        shortName: 'Beta',
        oidcClientSecret: sealedFor(BETA),
        publicBaseUrl: 'https://gemeinsam.example',
      }),
    ]);

    const offers = await h.login.offers('gemeinsam.example');

    expect(offers.filter((one) => one.atThisAddress)).toHaveLength(0);
  });

  it('marks nobody for an unknown host, no host, or an unreadable stored address', async () => {
    const rows = [
      offerable({ publicBaseUrl: 'https://formulare.alpha.example' }),
    ];

    for (const host of ['fremde.example', null, '']) {
      const offers = await harness(rows).login.offers(host);
      expect(offers.filter((one) => one.atThisAddress)).toHaveLength(0);
    }

    // A value that does not parse as a URL counts as an absent one — the same
    // posture `PublicUrlService.resolveBaseUrl` takes, and not an exception
    // escaping upwards.
    const broken = await harness([
      offerable({ publicBaseUrl: 'kein-url-wert' }),
    ]).login.offers('kein-url-wert');
    expect(broken.filter((one) => one.atThisAddress)).toHaveLength(0);
  });

  /**
   * **The load-bearing assertion.** `OidcConfigService.signIn` is the only way
   * a plaintext client secret enters this package, and the offer route must not
   * take it. Revert to `signInOrNull(row)` and this goes red for every row.
   */
  it('never builds an OidcSignIn — the only thing that carries the plaintext', async () => {
    const h = harness(ROW_CASES.map((one) => one.row));

    await h.login.offers(null);

    expect(h.signIn).not.toHaveBeenCalled();
  });

  /**
   * The drift guard for the copied rule. Not “both look plausible” — the same
   * verdict for the same row, for every row, measured through the route rather
   * than through a private method.
   */
  it('offers exactly the organisations signIn would sign somebody in at', async () => {
    for (const one of ROW_CASES) {
      const h = harness([one.row]);

      // `signIn` reports “unusable secret” by throwing and “not configured” by
      // returning `null`; the offer route collapses both into “offers nothing”,
      // which is the fail-closed reading and the one being compared.
      let expected: boolean;
      try {
        expected = (await h.config.signIn(one.row)) !== null;
      } catch {
        expected = false;
      }

      const offers = await h.login.offers(null);
      expect(offers.length === 1, one.name).toBe(expected);
    }
  });

  /** So the comparison above is not vacuously true on either side. */
  it('finds one usable row and ten unusable ones in that table', async () => {
    const h = harness(ROW_CASES.map((one) => one.row));

    await expect(h.login.offers(null)).resolves.toHaveLength(1);
    expect(ROW_CASES).toHaveLength(11);
  });

  /**
   * The residual, **counted rather than forbidden** — see the file comment.
   * One AES-GCM open per organisation that is configured except possibly for its
   * secret; an organisation that is switched off or half configured never reaches the
   * key holder at all, because the cheap conditions are asked first.
   */
  it('opens the box once per otherwise-configured Organisation and no more', async () => {
    const h = harness([
      offerable(),
      offerable({ oidcEnabled: false }),
      offerable({ oidcClientId: null }),
      offerable({ oidcClientSecret: sealedFor(BETA) }),
    ]);

    await h.login.offers(null);

    // Two: the fully configured Organisation, and the one whose secret belongs to
    // another organisation — that one has to be *tried* before it can be refused.
    expect(h.open.mock.calls).toHaveLength(2);
  });
});
