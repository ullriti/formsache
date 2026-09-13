import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ADMIN_GROUP_RANK,
  DEFAULT_GROUP_RANKS,
  DEFAULT_OIDC_EMAIL_CLAIM,
  DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
  DEFAULT_OIDC_SCOPES,
  USER_PASSWORD_MAX,
  USER_PASSWORD_MIN,
  accountKindSchema,
  formMemberWriteSchema,
  groupWriteSchema,
  mailIdentityConfigSchema,
  mailIdentityWriteSchema,
  oidcConfigSchema,
  oidcConfigWriteSchema,
  tenantBaseUrlSchema,
  tenantBaseUrlWriteSchema,
  deletedTenantListSchema,
  deletedTenantSchema,
  tenantCreateSchema,
  tenantDeleteSchema,
  tenantMemberCreateSchema,
  tenantMemberPasswordSchema,
  tenantMemberUpdateSchema,
  testMailRequestSchema,
  testMailResultSchema,
} from './tenant-admin.ts';

/**
 * The wire contract of the tenant administration, tested where it makes a promise
 * that other code would otherwise have to make again.
 *
 * The three that carry weight:
 *
 * - the OIDC read schema is an **allow list**, so a client secret cannot be
 *   added to a response without this file turning red;
 * - „Person hinzufügen" is a **discriminated union**, so a local account
 *   without a password is not expressible;
 * - the per-form restriction has **no field that grants**.
 */

const ISSUER = 'https://idp.example.org';
const UUID = '019fe400-0000-7000-8000-000000000001';
const OTHER_UUID = '019fe400-0000-7000-8000-000000000002';

const VALID_CONFIG = {
  enabled: true,
  issuer: ISSUER,
  clientId: 'formsache',
  scopes: [...DEFAULT_OIDC_SCOPES],
  emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
  emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
  buttonLabel: 'Mit der Organisation-Login anmelden',
  clientSecretSet: true,
  redirectUri: 'https://formulare.example.org/api/auth/oidc/callback',
};

describe('oidcConfigSchema', () => {
  it('reads exactly the nine fields of the tab, and no more', () => {
    const parsed = oidcConfigSchema.parse(VALID_CONFIG);
    expect(Object.keys(parsed).sort()).toStrictEqual([
      'buttonLabel',
      'clientId',
      'clientSecretSet',
      'emailClaim',
      'emailVerifiedClaim',
      'enabled',
      'issuer',
      'redirectUri',
      'scopes',
    ]);
  });

  /**
   * The allow list, as the reproduction asks for it: „enthält kein
   * Passwort" is the weaker form, because it stays green for the field nobody
   * thought of. A strict object refuses the field instead of dropping it, so a
   * handler that starts sending one cannot do it quietly.
   */
  it('refuses a payload carrying the client secret at all', () => {
    for (const key of ['clientSecret', 'clientSecretEncrypted', 'secret']) {
      const result = oidcConfigSchema.safeParse({
        ...VALID_CONFIG,
        [key]: 'super-geheim',
      });
      expect(result.success).toBe(false);
    }
  });

  it('accepts an organisation that has never configured a provider', () => {
    const parsed = oidcConfigSchema.parse({
      enabled: false,
      issuer: null,
      clientId: null,
      scopes: [],
      emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
      emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
      buttonLabel: null,
      clientSecretSet: false,
      redirectUri: 'https://formulare.example.org/api/auth/oidc/callback',
    });
    expect(parsed.enabled).toBe(false);
    expect(parsed.clientSecretSet).toBe(false);
  });
});

describe('oidcConfigWriteSchema', () => {
  const WRITE = {
    enabled: true,
    issuer: ISSUER,
    clientId: 'formsache',
    scopes: [...DEFAULT_OIDC_SCOPES],
    emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
    emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
    buttonLabel: 'Mit der Organisation-Login anmelden',
  };

  /**
   * **The caption stands in a mail as well** (ADR-0026): the SSO invitation
   * writes „wähle auf der Anmeldeseite die Schaltfläche „…""
   * (`oidcInvitationBody`). With that it is a foreign value in the body of a
   * system mail and carries the same condition as the two names — and the
   * caption is the value an organisation sets without any query at all.
   */
  it('weist eine Schaltflächen-Aufschrift mit Zeilenumbruch ab', () => {
    expect(
      oidcConfigWriteSchema.safeParse({
        ...WRITE,
        buttonLabel: 'Anmelden\n\nOder hier: https://boese.example',
      }).success,
    ).toBe(false);
  });

  /**
   * The three states of the secret field. „Absent" is the one that matters: the
   * page never held the value, so an update that keeps it has to be able to say
   * nothing rather than send something.
   */
  it('tells „keep", „replace" and „remove" apart', () => {
    expect('clientSecret' in oidcConfigWriteSchema.parse(WRITE)).toBe(false);
    expect(
      oidcConfigWriteSchema.parse({ ...WRITE, clientSecret: 'neu-und-lang' })
        .clientSecret,
    ).toBe('neu-und-lang');
    expect(
      oidcConfigWriteSchema.parse({ ...WRITE, clientSecret: null })
        .clientSecret,
    ).toBeNull();
    // An empty string is not „remove"; it is a secret of length zero and would
    // seal into a value that opens.
    expect(
      oidcConfigWriteSchema.safeParse({ ...WRITE, clientSecret: '' }).success,
    ).toBe(false);
  });

  /**
   * `redirect_uri` is decided by the server (third reproduction).
   * There is no field for it here — taking it from a request would turn the
   * login into an open redirector.
   */
  it('has no field in which a redirect address could be sent', () => {
    const result = oidcConfigWriteSchema.safeParse({
      ...WRITE,
      redirectUri: 'https://angreifer.example/callback',
    });
    expect(result.success).toBe(false);
  });

  it('refuses to switch SSO on without an issuer or a client id', () => {
    const withoutIssuer = oidcConfigWriteSchema.safeParse({
      ...WRITE,
      issuer: null,
    });
    expect(withoutIssuer.success).toBe(false);
    expect(withoutIssuer.error?.issues[0]?.path).toStrictEqual(['issuer']);

    const withoutClient = oidcConfigWriteSchema.safeParse({
      ...WRITE,
      clientId: null,
    });
    expect(withoutClient.success).toBe(false);
    expect(withoutClient.error?.issues[0]?.path).toStrictEqual(['clientId']);
  });

  it('insists on the openid scope while SSO is on', () => {
    const result = oidcConfigWriteSchema.safeParse({
      ...WRITE,
      scopes: ['profile', 'email'],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toStrictEqual(['scopes']);
  });

  /** Switched off, a half-filled configuration is a draft, not an error. */
  it('lets a switched-off configuration stay incomplete', () => {
    expect(
      oidcConfigWriteSchema.safeParse({
        enabled: false,
        issuer: null,
        clientId: null,
        scopes: [],
        emailClaim: DEFAULT_OIDC_EMAIL_CLAIM,
        emailVerifiedClaim: DEFAULT_OIDC_EMAIL_VERIFIED_CLAIM,
        buttonLabel: null,
      }).success,
    ).toBe(true);
  });

  /**
   * A scope is sent space-separated, so a space inside one would make two —
   * or add a parameter to the authorisation request.
   */
  it('refuses a scope that could become two', () => {
    expect(
      oidcConfigWriteSchema.safeParse({
        ...WRITE,
        scopes: ['openid profile'],
      }).success,
    ).toBe(false);
  });

  /**
   * **The asymmetry of the two claim names is the whole of the requirement**, and it
   * is the one thing a reader would get wrong from the field labels alone: the
   * verification claim may be emptied — that is the decision the entry offers —
   * while the address claim may not, because an empty one names no claim at all
   * and would leave the login reading `token['']`.
   */
  it('lets the verification claim be emptied, and the address claim not', () => {
    const withoutCheck = oidcConfigWriteSchema.safeParse({
      ...WRITE,
      emailVerifiedClaim: '',
    });
    expect(withoutCheck.success).toBe(true);
    expect(withoutCheck.data?.emailVerifiedClaim).toBe('');

    const withoutAddress = oidcConfigWriteSchema.safeParse({
      ...WRITE,
      emailClaim: '',
    });
    expect(withoutAddress.success).toBe(false);
    expect(withoutAddress.error?.issues[0]?.path).toStrictEqual(['emailClaim']);

    // Whitespace is not a name either — neither for the one that may be empty
    // (it trims to nothing and is then simply the empty decision) nor for the
    // one that may not.
    expect(
      oidcConfigWriteSchema.parse({ ...WRITE, emailVerifiedClaim: '' })
        .emailVerifiedClaim,
    ).toBe('');
    expect(
      oidcConfigWriteSchema.safeParse({ ...WRITE, emailClaim: '   ' }).success,
    ).toBe(false);
  });

  /** A claim is one key of the token, so a name with a space in it is not one. */
  it('refuses a claim name that is not a claim name', () => {
    for (const name of ['e mail', 'email address', 'a\nb', 'ä']) {
      expect(
        oidcConfigWriteSchema.safeParse({ ...WRITE, emailClaim: name }).success,
      ).toBe(false);
    }
    // What providers really mint, including Entra's URI-shaped legacy names.
    for (const name of [
      'upn',
      'preferred_username',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    ]) {
      expect(
        oidcConfigWriteSchema.safeParse({ ...WRITE, emailClaim: name }).success,
      ).toBe(true);
    }
  });
});

/**
 * The three shapes of `user` (ADR-0012 §3a) since the change that gave
 * an unclaimed invitation its own wire value instead of folding it into
 * `'oidc'` (review finding). Collapsing the two back onto each
 * other — the earlier `z.enum(['local', 'oidc'])` — makes the second
 * assertion here red: `'invited'` would no longer parse.
 */
describe('accountKindSchema', () => {
  it('accepts the three account shapes and nothing else', () => {
    expect(accountKindSchema.safeParse('local').success).toBe(true);
    expect(accountKindSchema.safeParse('oidc').success).toBe(true);
    expect(accountKindSchema.safeParse('invited').success).toBe(true);
    expect(accountKindSchema.safeParse('pending').success).toBe(false);
  });
});

describe('tenantMemberCreateSchema', () => {
  /**
   * **The `local` arm has no password field any more** (ADR-0024).
   *
   * Before, the opposite stood here („cannot express a local account without a
   * password"), and the reasoning was the form, not the matter: it made somebody
   * else the person who types the password and knows it. Now a typed password is
   * what cannot be written down — the person gets an invitation and sets it
   * themselves.
   *
   * Negative check: give the arm the field back and the second case turns green
   * and this test useless — that is why both stand in **one** case.
   */
  it('takes a local account without a password and refuses one with', () => {
    const base = {
      kind: 'local' as const,
      email: 'neu@example.org',
      name: 'Neue Person',
      groupId: UUID,
    };
    expect(tenantMemberCreateSchema.safeParse(base).success).toBe(true);
    expect(
      tenantMemberCreateSchema.safeParse({
        ...base,
        password: 'ein-langes-passwort',
      }).success,
    ).toBe(false);
  });

  /** …and no quieter second way in for a person the IdP owns. */
  it('has no password field on the OIDC variant', () => {
    const result = tenantMemberCreateSchema.safeParse({
      kind: 'oidc',
      email: 'neu@example.org',
      name: 'Neue Person',
      groupId: UUID,
      password: 'ein-langes-passwort',
    });
    expect(result.success).toBe(false);
  });

  /**
   * **The attack from ADR-0026, refused by the schema.**
   *
   * `name` travels verbatim into the body of the invitation mail, and `email`
   * determines the recipient — both out of **this** body. Without the condition
   * a holder of `can_manage_users` creates a person with line breaks in the name
   * and has the installation send an SPF/DKIM-signed mail to a freely chosen
   * mailbox, half of whose text they wrote. In the HTML version that was covered
   * (`escapeHtml`), in the text version it was not.
   *
   * *Counter-check:* remove `isSingleLineText` from `userNameSchema` → this
   * case turns red, and `test/tenant-admin/account-invitation.spec.ts` measures
   * the same line at the end in `mail_log.body_text`.
   */
  it('weist einen Namen mit Zeilenumbruch ab — beide Arme', () => {
    const attack =
      'Max\n\nDein Zugang läuft ab. Jetzt bestätigen: https://boese.example';
    for (const kind of ['local', 'oidc'] as const) {
      const refused = tenantMemberCreateSchema.safeParse({
        kind,
        email: 'opfer@example.org',
        name: attack,
        groupId: UUID,
      });
      expect(refused.success).toBe(false);
      expect(refused.error?.issues[0]?.path).toStrictEqual(['name']);
    }
  });

  /** And the invisible half of the same rule. */
  it('weist unsichtbare Steuerzeichen im Namen ab', () => {
    expect(
      tenantMemberCreateSchema.safeParse({
        kind: 'local',
        email: 'opfer@example.org',
        name: 'Max\u{202E}Muster',
        groupId: UUID,
      }).success,
    ).toBe(false);
  });

  it('normalises the e-mail the way the unique index compares it', () => {
    const parsed = tenantMemberCreateSchema.parse({
      kind: 'oidc',
      email: '  Neue.Person@Example.ORG ',
      name: '  Neue Person  ',
      groupId: UUID,
    });
    expect(parsed.email).toBe('neue.person@example.org');
    expect(parsed.name).toBe('Neue Person');
  });

  /**
   * The password bounds of this schema existed once, and they went with the
   * field (ADR-0024). What they checked — that an address-plus-password has the
   * same bounds here and when signing in — is still checked by `auth.test.ts`
   * for `passwordResetConfirmSchema`: since this change that is **the** place at
   * which a password of this application comes into being.
   */
});

describe('groupWriteSchema', () => {
  const GROUP = {
    name: 'Redaktion',
    color: '#7c0800',
    rank: DEFAULT_GROUP_RANKS.editor,
    permissions: {
      canBuild: true,
      canViewResponses: true,
      canExport: false,
      canManageSettings: false,
      canManageFormSettings: false,
      canManageUsers: false,
    },
  };

  it('takes the six permissions as one object, never one at a time', () => {
    const parsed = groupWriteSchema.parse(GROUP);
    expect(Object.keys(parsed.permissions).sort()).toStrictEqual([
      'canBuild',
      'canExport',
      // The two „Einstellungen" next to each other, and the list stands there
      // written out, so that a seventh permission makes this test red instead
      // of slipping through quietly (ADR-0021).
      'canManageFormSettings',
      'canManageSettings',
      'canManageUsers',
      'canViewResponses',
    ]);
    expect(
      groupWriteSchema.safeParse({
        ...GROUP,
        permissions: { canBuild: true },
      }).success,
    ).toBe(false);
  });

  /**
   * Roles are compared by rank, so an editable group reaching the system
   * group's rank would make „wer ist höher" — and with it „Administratoren sind
   * nie einschränkbar" — ambiguous.
   */
  it('keeps every editable group below the admin rank', () => {
    expect(
      groupWriteSchema.safeParse({ ...GROUP, rank: ADMIN_GROUP_RANK }).success,
    ).toBe(false);
    expect(
      groupWriteSchema.safeParse({ ...GROUP, rank: ADMIN_GROUP_RANK - 1 })
        .success,
    ).toBe(true);
    expect(groupWriteSchema.safeParse({ ...GROUP, rank: -1 }).success).toBe(
      false,
    );
  });

  /** The tint goes through the predicate `auth.ts` has had. */
  it('refuses a colour that is not a hex literal', () => {
    for (const color of ['red', '#12345', '#fff; } body {', '']) {
      expect(groupWriteSchema.safeParse({ ...GROUP, color }).success).toBe(
        false,
      );
    }
  });

  it('refuses a group with an empty name', () => {
    expect(groupWriteSchema.safeParse({ ...GROUP, name: '   ' }).success).toBe(
      false,
    );
  });
});

describe('formMemberWriteSchema', () => {
  /**
   * The structural half of „eine Restriktion kann nie hochstufen": there is no
   * field that adds. Whatever a caller invents is refused rather than ignored,
   * so a future handler cannot start honouring it by accident.
   */
  it('has no field that grants anything', () => {
    for (const granting of [
      { permissions: { canExport: true } },
      { grantedGroupId: OTHER_UUID },
      { canExport: true },
      { isAdmin: true },
    ]) {
      const result = formMemberWriteSchema.safeParse({
        accessRevoked: false,
        cappedGroupId: null,
        ...granting,
      });
      expect(result.success).toBe(false);
    }
  });

  /** Lifting a restriction is the same document, not a second route. */
  it('expresses „keine Einschränkung" as a value', () => {
    expect(
      formMemberWriteSchema.parse({
        accessRevoked: false,
        cappedGroupId: null,
      }),
    ).toStrictEqual({ accessRevoked: false, cappedGroupId: null });
    expect(
      formMemberWriteSchema.parse({
        accessRevoked: true,
        cappedGroupId: UUID,
      }).cappedGroupId,
    ).toBe(UUID);
  });
});

describe('tenantCreateSchema', () => {
  const TENANT = {
    shortName: 'Musterstadt',
    name: 'Ortsgruppe Musterstadt',
    admin: {
      email: 'admin@musterstadt.example',
      name: 'Erster Admin',
    },
  };

  /**
   * **The second write path onto `tenant.name`** (ADR-0026).
   *
   * `tenantBrandingWriteSchema.name` is the first one; this one here weighs
   * more, because the name goes straight into the invitation of the first
   * administrator (`AdminService.plannedInvitation`) — a mail that the same call
   * triggers. The name of the person falls under `userNameSchema` and is
   * measured above.
   */
  it('weist einen Organisationsnamen mit Zeilenumbruch ab — und einen Personennamen', () => {
    expect(
      tenantCreateSchema.safeParse({
        ...TENANT,
        name: 'Ortsgruppe\n\nBitte hier bestätigen: https://boese.example',
      }).success,
    ).toBe(false);
    expect(
      tenantCreateSchema.safeParse({
        ...TENANT,
        admin: { ...TENANT.admin, name: 'Erster\nAdmin' },
      }).success,
    ).toBe(false);
  });

  it('takes an organisation and its first admin, and nothing else', () => {
    const parsed = tenantCreateSchema.parse(TENANT);
    expect(Object.keys(parsed).sort()).toStrictEqual([
      'admin',
      'name',
      'shortName',
    ]);
  });

  /**
   * The absence is deliberate: a field for the form standards would be the
   * invitation to copy them, and an organisation whose standards are set never inherits
   * from the system layer again.
   */
  /**
   * **No password for the first administrator** (ADR-0024) — they get an
   * invitation like every other person too.
   *
   * The one exception stays `setupRequestSchema`: at the initial setup there is
   * neither a mail server nor a base address over which an invitation could go
   * (`setup.test.ts` holds the counter-check).
   */
  it('has no password field for the first administrator', () => {
    expect(
      tenantCreateSchema.safeParse({
        ...TENANT,
        admin: { ...TENANT.admin, password: 'korrektes-pferd-batterie' },
      }).success,
    ).toBe(false);
  });

  it('has no field in which form standards could be copied along', () => {
    for (const extra of [
      { formDefaults: {} },
      { settings: {} },
      { branding: { accent: '#cea967' } },
      { oidc: { enabled: true } },
    ]) {
      expect(
        tenantCreateSchema.safeParse({ ...TENANT, ...extra }).success,
      ).toBe(false);
    }
  });

  it('insists on a first admin — an organisation without one is unusable', () => {
    expect(
      tenantCreateSchema.safeParse({
        shortName: TENANT.shortName,
        name: TENANT.name,
      }).success,
    ).toBe(false);
  });

  /**
   * **„Mich selbst als ersten Administrator eintragen"** (review finding 7).
   *
   * `null` is the stated decision, a missing key is none — the case above
   * therefore stays a 400.
   */
  it('takes null as „das angemeldete Superadmin-Konto"', () => {
    expect(tenantCreateSchema.parse({ ...TENANT, admin: null }).admin).toBe(
      null,
    );
  });

  /**
   * The counter-check to the same finding: there is **no** field with which the
   * caller names an account. Who „ich selbst" is, is decided by the server out
   * of the session; an `adminUserId` would be the way to make a foreign person
   * the administrator of an organisation without their learning of it.
   */
  it('has no field in which a caller could name somebody else’s account', () => {
    for (const extra of [
      { adminUserId: '019ff600-0000-7000-8000-0000000000a1' },
      { adminId: '019ff600-0000-7000-8000-0000000000a1' },
    ]) {
      expect(
        tenantCreateSchema.safeParse({ ...TENANT, admin: null, ...extra })
          .success,
      ).toBe(false);
    }
  });

  it('keeps the Kurzname to characters that never need escaping', () => {
    for (const shortName of ['a b', 'ä', 'x/y', '<script>', 'a']) {
      expect(
        tenantCreateSchema.safeParse({ ...TENANT, shortName }).success,
      ).toBe(false);
    }
    expect(
      tenantCreateSchema.parse({
        ...TENANT,
        shortName: '  Dachorganisation-Nord ',
      }).shortName,
    ).toBe('Dachorganisation-Nord');
  });
});

/**
 * The seed's group ranks, guarded from here because they cannot be merged from
 * here.
 *
 * `apps/api/prisma/seed.ts` writes the three delivered groups with `rank: 100`,
 * `60` and `20` spelled out — the same three numbers {@link DEFAULT_GROUP_RANKS}
 * states. That is a value copy under a *different* identifier, so
 * `single-source.test.ts` (which matches on the name) looks straight past it,
 * and it is invisible from the outside for as long as the two agree: setting the
 * constant's `editor` to `61` left 22 test files green, because the shared tests
 * derive their input from the constant and the API tests derive theirs from the
 * seeded rows.
 *
 * **The proper fix is one line in the seed** — importing `DEFAULT_GROUP_RANKS`
 * instead of restating it — and it belongs to whoever owns `apps/api`. Until
 * then the agreement is measured rather than assumed: this reads the file. The
 * extraction is asserted to have found all three groups, so a seed that is
 * restructured fails loudly here instead of quietly passing over nothing.
 */
describe('the delivered group ranks', () => {
  const SEED = readFileSync(
    resolve(process.cwd(), '..', '..', 'apps', 'api', 'prisma', 'seed.ts'),
    'utf8',
  );

  const byName = (
    entries: readonly (readonly [string, number])[],
  ): (readonly [string, number])[] =>
    [...entries].sort(([one], [other]) => one.localeCompare(other));

  const seeded: (readonly [string, number])[] = [
    ...SEED.matchAll(/name: '([a-z]+)',\s*color: '[^']*',\s*rank: (\d+)/g),
  ].map((match) => [match[1] ?? '', Number(match[2])] as const);

  const expected = Object.entries(DEFAULT_GROUP_RANKS);

  it('finds the groups it claims to read', () => {
    expect(
      seeded.map(([name]) => name).sort(),
      'The delivered groups could not be read out of apps/api/prisma/seed.ts. ' +
        'If the seed was restructured, the right repair is to import ' +
        'DEFAULT_GROUP_RANKS there rather than to teach this test a second shape.',
    ).toEqual(expected.map(([name]) => name).sort());
  });

  it('seeds exactly the ranks the shared constant states', () => {
    expect(
      byName(seeded),
      'The seed and DEFAULT_GROUP_RANKS disagree about a rank. Roles are ' +
        'compared by rank, so an organisation created by the seed and one created ' +
        'through the API would answer „wer ist höher" differently.',
    ).toEqual(byName(expected));
  });
});

/**
 * The mail server of an organisation (ADR-0013, ADR-0023).
 *
 * Three promises are checked here and none of them further below: the block is
 * **indivisible**, so a half-filled one is not a document that fails the check
 * but one that cannot be written down; the read document is an **allow
 * list**, so no SMTP password can be taken into a response without this file
 * turning red; and **there is no arm „erbt vom System" any more** (ADR-0023) —
 * the attempt to write it is a rejection.
 * ⚠️ The strongest half of the requirement — „ein Dokument, das **nur** `from` setzt, ist
 * nicht ausdrückbar" — hangs off `pnpm typecheck`, not off this suite: Vitest
 * runs through SWC, which strips types without checking them (ADR-0013 no. 1).
 */
describe('the mail server of an organisation', () => {
  const ownBlock = {
    host: 'mail.organisation.example',
    port: 587,
    secure: false,
    from: 'post@organisation.example',
  } as const;

  it('liest `smtp: null` als „noch keiner eingetragen"', () => {
    expect(mailIdentityConfigSchema.parse({ smtp: null })).toStrictEqual({
      smtp: null,
    });
  });

  /**
   * **The reproduction of ADR-0023.** If the inheritance came back, it would
   * come back as exactly this document — and this line would be green.
   */
  it('kennt keinen Arm „erbt vom System" mehr', () => {
    expect(
      mailIdentityConfigSchema.safeParse({ source: 'system' }).success,
    ).toBe(false);
    expect(
      mailIdentityWriteSchema.safeParse({ source: 'system' }).success,
    ).toBe(false);
    // The dangerous mixture, spelled out the way an editor would try it:
    // a foreign transport with an own sender address (ADR-0013 no. 2).
    expect(
      mailIdentityWriteSchema.safeParse({
        smtp: { from: 'vorstand@example.org' },
      }).success,
    ).toBe(false);
  });

  it('refuses a half-filled block and names the missing field', () => {
    const result = mailIdentityWriteSchema.safeParse({
      smtp: { ...ownBlock, port: undefined, auth: null },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      'smtp.port',
    );
  });

  it('keeps the credentials a pair — user without password is „keep", password without user is nothing', () => {
    // Absent password: „lass das gespeicherte stehen", the ordinary save.
    expect(
      mailIdentityWriteSchema.safeParse({
        smtp: { ...ownBlock, auth: { user: 'postmaster' } },
      }).success,
    ).toBe(true);
    // A password on its own is not a document: the pair has no half.
    expect(
      mailIdentityWriteSchema.safeParse({
        smtp: { ...ownBlock, auth: { password: 'geheim' } },
      }).success,
    ).toBe(false);
    // And a relay without a login stays expressible — `null`, both halves at
    // once, never an emptied password next to a kept user.
    expect(
      mailIdentityWriteSchema.safeParse({ smtp: { ...ownBlock, auth: null } })
        .success,
    ).toBe(true);
  });

  it('carries „gesetzt" and not the password, as a allow list', () => {
    const config = mailIdentityConfigSchema.parse({
      smtp: { ...ownBlock, auth: { user: 'postmaster', passwordSet: true } },
    });
    expect(Object.keys(config)).toStrictEqual(['smtp']);
    expect(Object.keys(config.smtp ?? {}).sort()).toEqual([
      'auth',
      'from',
      'host',
      'port',
      'secure',
    ]);
    // The reproduction: the password taken into the read payload.
    expect(
      mailIdentityConfigSchema.safeParse({
        smtp: {
          ...ownBlock,
          auth: { user: 'postmaster', passwordSet: true, password: 'geheim' },
        },
      }).success,
    ).toBe(false);
  });

  it('uses the same predicates the stored block uses', () => {
    // The port range of `mail-config.ts`, not a second opinion about it.
    expect(
      mailIdentityWriteSchema.safeParse({
        smtp: { ...ownBlock, port: 70_000, auth: null },
      }).success,
    ).toBe(false);
    // A bare address, never `Name <adresse>` — the display name is separate.
    expect(
      mailIdentityWriteSchema.safeParse({
        smtp: {
          ...ownBlock,
          from: 'Organisation <post@organisation.example>',
          auth: null,
        },
      }).success,
    ).toBe(false);
  });
});

/**
 * The organisation's own base address — its own document,
 * deliberately separate from {@link mailIdentityConfigSchema} (ADR-0013 no. 3):
 * an organisation sets or clears it independently of which mail transport it uses.
 */
describe('tenantBaseUrlSchema / tenantBaseUrlWriteSchema', () => {
  it('reads null as „die Systemvorgabe gilt"', () => {
    expect(tenantBaseUrlSchema.parse({ baseUrl: null })).toStrictEqual({
      baseUrl: null,
    });
  });

  it('round-trips a set address and carries nothing else (allow list)', () => {
    const result = tenantBaseUrlSchema.parse({
      baseUrl: 'https://organisation.example.org',
    });
    expect(Object.keys(result)).toStrictEqual(['baseUrl']);
  });

  it('normalises a write the same way the system row does — trailing slash dropped', () => {
    const written = tenantBaseUrlWriteSchema.parse({
      baseUrl: 'https://organisation.example.org/',
    });
    expect(written.baseUrl).toBe('https://organisation.example.org');
  });

  it('accepts null on a write — clearing the organisation’s own address', () => {
    expect(tenantBaseUrlWriteSchema.safeParse({ baseUrl: null }).success).toBe(
      true,
    );
  });

  it('refuses a value that is not an absolute http(s) base address', () => {
    for (const invalid of ['not-a-url', 'ftp://organisation.example', '  ']) {
      const result = tenantBaseUrlWriteSchema.safeParse({ baseUrl: invalid });
      expect(result.success).toBe(false);
      expect(
        result.error?.issues.map((issue) => issue.path.join('.')),
      ).toContain('baseUrl');
    }
  });

  it('refuses an empty string rather than treating it as „leer" — a write clears with null, not with „"', () => {
    // `baseUrlSchema` requires at least one character; an editor that wants to
    // clear the field sends `null`, not the empty string it happens to leave
    // behind — the same distinction `mail-identity-draft.ts`'s `trimmedOrNull`
    // makes before this schema ever sees a value.
    expect(tenantBaseUrlWriteSchema.safeParse({ baseUrl: '' }).success).toBe(
      false,
    );
  });
});

describe('the Testmail request (Offener Punkt 4)', () => {
  it('accepts only the empty document', () => {
    expect(testMailRequestSchema.safeParse({}).success).toBe(true);
  });

  it('has no field an eingetippter, unsaved SMTP block could travel in', () => {
    // What must be airtight here: there is no key at all for
    // host, port or credentials — a request that carries one is refused by
    // the schema, not by a handler that happens to ignore it.
    for (const key of ['host', 'port', 'secure', 'from', 'auth', 'source']) {
      expect(
        testMailRequestSchema.safeParse({ [key]: 'anything' }).success,
      ).toBe(false);
    }
  });
});

describe('the Testmail result', () => {
  it('round-trips a successful send', () => {
    const result = testMailResultSchema.parse({
      recipientEmail: 'editor@organisation.example',
      status: 'sent',
      reason: null,
    });
    expect(result.status).toBe('sent');
    expect(result.reason).toBeNull();
  });

  it('carries a reason on failure and nothing else (allow list)', () => {
    const result = testMailResultSchema.parse({
      recipientEmail: 'editor@organisation.example',
      status: 'failed',
      reason: 'Eine Verbindung zum Mailserver war nicht möglich.',
    });
    expect(Object.keys(result).sort()).toEqual([
      'reason',
      'recipientEmail',
      'status',
    ]);
  });
});

/**
 * **Deleting an organisation and fetching it back.**
 *
 * Two promises the database suite cannot see: the confirmation is a *field*
 * rather than a client-side habit, and the „Gelöschte Organisationen" row carries the
 * organisation's identity and **nothing of what is inside it**. The second one is the
 * shape of the requirement — a section of the overview, not a systemwide trash
 * that reaches domain data without restoring the organisation first.
 */
describe('deleting and restoring an organisation', () => {
  const SUMMARY = {
    id: '019ffd00-0000-7000-8000-0000000000ff',
    shortName: 'ALT',
    name: 'Alte Verein',
    logoRef: null,
    branding: {
      accent: '#cea967',
      headerBg: '#212226',
      canvasBg: '#e9e6df',
      stripe: ['#212226', '#7c0800', '#cea967'],
      wideLogo: false,
    },
  };

  it('demands a typed name and nothing else', () => {
    expect(
      tenantDeleteSchema.parse({ confirmName: 'Alte Verein' }).confirmName,
    ).toBe('Alte Verein');
    // An empty confirmation is no confirmation — the field exists to make the
    // act deliberate, so „" must not pass as „abgetippt".
    expect(tenantDeleteSchema.safeParse({ confirmName: '   ' }).success).toBe(
      false,
    );
    expect(tenantDeleteSchema.safeParse({}).success).toBe(false);
  });

  it('refuses a payload that carries anything besides the confirmation', () => {
    // `strictObject`: a `force: true` bolted on by a client must not be
    // something the server has to remember to ignore.
    expect(
      tenantDeleteSchema.safeParse({
        confirmName: 'Alte Verein',
        force: true,
      }).success,
    ).toBe(false);
  });

  it('lists a deleted Organisation with its identity and the moment it went', () => {
    const row = deletedTenantSchema.parse({
      tenant: SUMMARY,
      deletedAt: '2026-08-03T12:00:00.000Z',
    });
    expect(Object.keys(row).sort()).toEqual(['deletedAt', 'tenant']);
  });

  it('carries nothing of what is inside a deleted Organisation', () => {
    // The load-bearing assertion of the requirement: the row is `strictObject`, so a
    // later „forms"/„responses"/„trash" field cannot be added to the payload
    // without this test naming it. A deleted Organisation stays unbetretbar.
    for (const extra of [
      { forms: 3 },
      { responses: 40 },
      { users: 2 },
      { trash: { forms: [], responses: [] } },
    ]) {
      expect(
        deletedTenantSchema.safeParse({
          tenant: SUMMARY,
          deletedAt: '2026-08-03T12:00:00.000Z',
          ...extra,
        }).success,
      ).toBe(false);
    }
  });

  it('refuses a deletion moment that is not a timestamp', () => {
    expect(
      deletedTenantSchema.safeParse({ tenant: SUMMARY, deletedAt: 'gestern' })
        .success,
    ).toBe(false);
    // And it is not optional: a row without one cannot say „noch 23 Tage".
    expect(deletedTenantSchema.safeParse({ tenant: SUMMARY }).success).toBe(
      false,
    );
  });

  it('reads an empty section', () => {
    expect(deletedTenantListSchema.parse({ tenants: [] })).toEqual({
      tenants: [],
    });
  });
});

/**
 * **Role, name and address of a member** (finding 12).
 *
 * The schema only says *what* may be sent. Whether an address change **is**
 * allowed — local account, no second organisation, no system administration —
 * is decided by the server, and is proven in
 * `apps/api/test/tenant-admin/member-account.spec.ts`.
 */
describe('tenantMemberUpdateSchema', () => {
  /**
   * **The same bolt at the second write path** (ADR-0026): renaming a person
   * writes the same column, and the next invitation or reset mail carries the
   * new name. A rule that only stands at the creation is no rule.
   */
  it('weist einen Namen mit Zeilenumbruch ab', () => {
    expect(
      tenantMemberUpdateSchema.safeParse({
        name: 'Max\nMuster',
        email: 'max@example.org',
        groupId: UUID,
      }).success,
    ).toBe(false);
  });

  it('verlangt alle drei Felder — `PUT` ist eine Aussage über den Zielzustand', () => {
    expect(tenantMemberUpdateSchema.safeParse({ groupId: UUID }).success).toBe(
      false,
    );
    expect(
      tenantMemberUpdateSchema.safeParse({
        groupId: UUID,
        name: 'Anna Beispiel',
        email: 'anna@example.org',
      }).success,
    ).toBe(true);
  });

  it('normalisiert die Adresse wie jeder andere Schreibweg auf diese Spalte', () => {
    expect(
      tenantMemberUpdateSchema.parse({
        groupId: UUID,
        name: '  Anna Beispiel ',
        email: '  Anna@Example.ORG ',
      }),
    ).toEqual({
      groupId: UUID,
      name: 'Anna Beispiel',
      email: 'anna@example.org',
    });
  });

  it('hat kein Feld für ein Passwort — das ist eine eigene Route', () => {
    // A password that travelled along incidentally in a `PUT` would be an act
    // without a confirmation of its own: the setting ends **every** session of
    // the person, and that does not belong in a body called „Rolle ändern".
    expect(
      tenantMemberUpdateSchema.safeParse({
        groupId: UUID,
        name: 'Anna',
        email: 'anna@example.org',
        password: 'x'.repeat(USER_PASSWORD_MIN),
      }).success,
    ).toBe(false);
  });
});

describe('tenantMemberPasswordSchema', () => {
  it('teilt Mindest- und Höchstmaß mit jedem anderen Setzweg', () => {
    expect(
      tenantMemberPasswordSchema.safeParse({
        password: 'x'.repeat(USER_PASSWORD_MIN),
      }).success,
    ).toBe(true);
    expect(
      tenantMemberPasswordSchema.safeParse({
        password: 'x'.repeat(USER_PASSWORD_MIN - 1),
      }).success,
    ).toBe(false);
    expect(
      tenantMemberPasswordSchema.safeParse({
        password: 'x'.repeat(USER_PASSWORD_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('kennt kein `currentPassword` — wer hier schreibt, ist nicht die Person', () => {
    expect(
      tenantMemberPasswordSchema.safeParse({
        password: 'x'.repeat(USER_PASSWORD_MIN),
        currentPassword: 'irgendwas',
      }).success,
    ).toBe(false);
  });
});
