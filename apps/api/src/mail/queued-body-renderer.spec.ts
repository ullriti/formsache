import { describe, expect, it, vi } from 'vitest';
import { EDIT_LINK_MARK, type FormSettings } from '@formsache/shared';

import type { PublicUrlService } from '../common/public-url/public-url.service';
import type { PrismaService } from '../prisma/prisma.service';
import type * as SettingsEnforcement from '../settings/settings-enforcement';
import type { SigningService } from '../common/secret-box/signing.service';
import { QueuedBodyRenderer } from './queued-body-renderer';

/**
 * **The requirement, second reproduction — at the one call site that has no
 * session to read by mistake.**
 *
 * `QueuedBodyRenderer` is the render step of the mail *worker*
 * (`MailWorkerService.runOnce`), and the worker claims rows by primary key —
 * there is no request behind it, no cookie, no membership, nothing a
 * `TenantScope` could be built from. That absence is not incidental to this
 * test, it is the whole of what this second reproduction asks for: "reading from
 * the session's organisation" is not merely the wrong answer here, there is no
 * session-shaped value anywhere in this class's constructor or method signatures
 * for a future edit to reach for. The end-to-end version of the same claim — two
 * organisations, two addresses, drained in one worker run — lives in
 * `test/public/frozen-mail-body.spec.ts`, which is a real database and the
 * real `MailWorkerService`; this file isolates the one decision that
 * database round-trip cannot show as cleanly: **which value this class hands
 * to `PublicUrlService.responseEditUrl` as the tenant**.
 *
 * `enforcedSettings` is mocked rather than fed a real settings document: the
 * merge itself is `packages/shared`'s and `settings-enforcement.spec.ts`'s
 * subject, not this file's, and building two valid override documents by
 * hand here would test the fixture more than the routing this class is
 * responsible for.
 */

const { enforcedSettingsMock } = vi.hoisted(() => ({
  enforcedSettingsMock: vi.fn<() => FormSettings>(),
}));

vi.mock('../settings/settings-enforcement', async (importOriginal) => {
  const actual = await importOriginal<typeof SettingsEnforcement>();
  return { ...actual, enforcedSettings: enforcedSettingsMock };
});

interface FakeResponseRow {
  readonly editToken: string | null;
  readonly form: {
    readonly id: string;
    readonly status: string;
    readonly deletedAt: Date | null;
    readonly settingsOverride: unknown;
    readonly tenant: { readonly id: string; readonly formDefaults: unknown };
  };
}

/** Records every call rather than answering a single canned value, so a test
 * can tell "called once with the right argument" from "called with the last
 * of several, coincidentally right, arguments".
 *
 * Ever since the footer links into the system, the two **base** addresses
 * belong to it: `bases` is not only answered but also recorded — whoever
 * asked the chain via the organisation for a system mail would thereby stand
 * in `baseCalls` and not only in the result. */
function fakePublicUrls(
  bases: {
    readonly installation?: string | null;
    readonly tenant?: string | null;
  } = {},
): {
  readonly service: PublicUrlService;
  readonly calls: { tenantId: string; editToken: string }[];
  readonly baseCalls: ('installation' | `tenant:${string}`)[];
} {
  const calls: { tenantId: string; editToken: string }[] = [];
  const baseCalls: ('installation' | `tenant:${string}`)[] = [];
  const service = {
    responseEditUrl: (tenantId: string, editToken: string) => {
      calls.push({ tenantId, editToken });
      return Promise.resolve(`https://${tenantId}.test.invalid/a/${editToken}`);
    },
    installationBaseUrl: () => {
      baseCalls.push('installation');
      return Promise.resolve(bases.installation ?? null);
    },
    resolveBaseUrl: (tenantId: string) => {
      baseCalls.push(`tenant:${tenantId}`);
      return Promise.resolve(bases.tenant ?? null);
    },
  } as unknown as PublicUrlService;
  return { service, calls, baseCalls };
}

/**
 * The signer that none of these cases uses.
 *
 * The reset mark does not occur in the bodies here, so
 * `resetUrlFor` does not even ask — and that it does not do so is itself
 * a statement: a confirmation mail resolves no reset row. A
 * `sign` that throws would be a prettier proof of that and would at the same time be a
 * second claim in a file that checks one.
 */
function fakeSigning(): SigningService {
  return {
    sign: () => 'nie-benutzt',
  } as unknown as SigningService;
}

function fakePrisma(
  rows: readonly (FakeResponseRow | null)[],
  /**
   * The organisation row from which the envelope takes colour and name — `null`
   * for "this organisation no longer exists", the case that may cost the colour
   * and not the mail.
   */
  tenant: { readonly name: string; readonly accentColor: string } | null = {
    name: 'Ortsgruppe Musterstadt',
    accentColor: '#123abc',
  },
): PrismaService {
  let call = 0;
  return {
    response: {
      findFirst: () => {
        const row = rows[call] ?? null;
        call += 1;
        return Promise.resolve(row);
      },
    },
    tenant: {
      findUnique: () => Promise.resolve(tenant),
    },
    // No reset row: the system mail of this file is the notification
    // about a password that has been set, and that carries no authorisation (ADR-0024).
    passwordResetToken: {
      findUnique: () => Promise.resolve(null),
    },
  } as unknown as PrismaService;
}

function row(
  tenantId: string,
  formId: string,
  editToken: string,
): FakeResponseRow {
  return {
    editToken,
    form: {
      id: formId,
      status: 'active',
      deletedAt: null,
      settingsOverride: {},
      tenant: { id: tenantId, formDefaults: {} },
    },
  };
}

/**
 * **A review finding.** The tests above prove `QueuedBodyRenderer` does not
 * *use* a session; they say nothing about whether the constructor could
 * still be handed one. Pinning the arity is the mechanical floor under the
 * class comment's claim "there is no session-shaped value anywhere in this
 * class's constructor" — it turns red the moment somebody injects a fourth
 * collaborator (a `TenantScope`, say), long before that collaborator is ever
 * called.
 *
 * Arity rather than a parameter-name or -type check: `Function.length`
 * counts constructor parameters without a default value, which is exactly
 * what dependency injection resolves against, and needs nothing from
 * `reflect-metadata` or a compiled type to read.
 */
describe('QueuedBodyRenderer’s constructor stays at exactly its three known collaborators (a review finding)', () => {
  it('has an arity of 3 — prisma, publicUrls, systemSettings, nothing else', () => {
    expect(QueuedBodyRenderer.length).toBe(3);
  });
});

describe('QueuedBodyRenderer resolves the edit link’s Organisation from the claimed row, never a session', () => {
  it('passes the form’s own tenant to PublicUrlService — a different one for each of two rows in the same run', async () => {
    enforcedSettingsMock.mockReturnValue({ allowEdit: true } as FormSettings);

    const rowA = row('tenant-a', 'form-a', 'token-a');
    const rowB = row('tenant-b', 'form-b', 'token-b');
    const { service: publicUrls, calls } = fakePublicUrls();
    const renderer = new QueuedBodyRenderer(
      fakePrisma([rowA, rowB]),
      publicUrls,
      fakeSigning(),
    );

    const bodyA = await renderer.render({
      id: 'mail-a',
      // A confirmation, not a system mail — the branch that does not even enter
      // the reset resolution (ADR-0020).
      trigger: 'submit',
      tenantId: 'tenant-a',
      responseId: 'response-a',
      bodyText: `Ändern: ${EDIT_LINK_MARK}`,
      bodyHtml: null,
    });
    const bodyB = await renderer.render({
      id: 'mail-b',
      trigger: 'submit',
      tenantId: 'tenant-b',
      responseId: 'response-b',
      bodyText: `Ändern: ${EDIT_LINK_MARK}`,
      bodyHtml: null,
    });

    // The tenant handed to `PublicUrlService` is the **form's**, read off the
    // row this method itself fetched — never a constant, never the other
    // row's value, and (structurally, by the absence of any such parameter
    // anywhere in this class) never a session's.
    expect(calls).toEqual([
      { tenantId: 'tenant-a', editToken: 'token-a' },
      { tenantId: 'tenant-b', editToken: 'token-b' },
    ]);
    expect(bodyA.text).toContain('tenant-a.test.invalid/a/token-a');
    expect(bodyA.text).not.toContain('tenant-b');
    expect(bodyB.text).toContain('tenant-b.test.invalid/a/token-b');
    expect(bodyB.text).not.toContain('tenant-a');
  });

  it('asks nothing at all when the answer carries no link (allowEdit off)', async () => {
    enforcedSettingsMock.mockReturnValue({ allowEdit: false } as FormSettings);
    const { service: publicUrls, calls } = fakePublicUrls();
    const renderer = new QueuedBodyRenderer(
      fakePrisma([row('tenant-a', 'form-a', 'token-a')]),
      publicUrls,
      fakeSigning(),
    );

    const body = await renderer.render({
      id: 'mail-a',
      // A confirmation, not a system mail — the branch that does not even enter
      // the reset resolution (ADR-0020).
      trigger: 'submit',
      tenantId: 'tenant-a',
      responseId: 'response-a',
      bodyText: `Danke! Ändern: ${EDIT_LINK_MARK} Bis bald.`,
      bodyHtml: null,
    });

    expect(calls).toEqual([]);
    expect(body.text).not.toContain('/a/');
    expect(body.text).not.toContain(EDIT_LINK_MARK);
    expect(body.text).toContain('Danke!');
    expect(body.text).toContain('Bis bald.');
  });
});

/**
 * **The envelope** (finding 31) — that which turns the stored body into a
 * deliverable HTML mail.
 *
 * What is checked are the two properties at which something can break here:
 * the **order** (first fill the marks, then wrap) and the
 * **direction of the failure** (an organisation that no longer exists
 * costs the colour, not the delivery).
 */
describe('QueuedBodyRenderer hüllt den HTML-Rumpf in ein Maildokument', () => {
  it('füllt die Marke zuerst und legt die Hülle darum — nie umgekehrt', async () => {
    enforcedSettingsMock.mockReturnValue({ allowEdit: true } as FormSettings);
    const { service: publicUrls } = fakePublicUrls();
    const renderer = new QueuedBodyRenderer(
      fakePrisma([row('tenant-a', 'form-a', 'token-a')]),
      publicUrls,
      fakeSigning(),
    );

    const body = await renderer.render({
      id: 'mail-a',
      trigger: 'submit',
      tenantId: 'tenant-a',
      responseId: 'response-a',
      bodyText: `Ändern: ${EDIT_LINK_MARK}`,
      bodyHtml: `<p>Ändern: ${EDIT_LINK_MARK}</p>`,
    });

    const html = body.html ?? '';
    // The envelope is there …
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8" />');
    // … it carries the colour of the organisation …
    expect(html).toContain('background-color:#123abc');
    // … and the mark is resolved **inside** the envelope, not left
    // standing. Wrapping before inserting would leave the mark standing in a
    // delivered mail — the one outcome that is worse than no
    // link.
    expect(html).not.toContain(EDIT_LINK_MARK);
    expect(html).toContain('tenant-a.test.invalid/a/token-a');
    // The text version gets no HTML — but it does get its own footer.
    expect(body.text).not.toContain('<!doctype');
    expect(body.text).toContain('Diese E-Mail wurde automatisch erzeugt.');
  });

  it('lässt die Mail hinausgehen, wenn es die Organisation nicht mehr gibt', async () => {
    enforcedSettingsMock.mockReturnValue({ allowEdit: false } as FormSettings);
    const { service: publicUrls } = fakePublicUrls();
    const renderer = new QueuedBodyRenderer(
      fakePrisma([null], null),
      publicUrls,
      fakeSigning(),
    );

    const body = await renderer.render({
      id: 'mail-a',
      trigger: 'submit',
      tenantId: 'tenant-weg',
      responseId: 'response-a',
      bodyText: 'Danke!',
      bodyHtml: '<p>Danke!</p>',
    });

    // No throw, a document — and the content complete inside it.
    expect(body.html ?? '').toContain('<p>Danke!</p>');
    expect(body.html ?? '').toContain('<!doctype html>');
  });
});

/**
 * **The link in the footer — which of the two base addresses** (the
 * requirement).
 *
 * The rule is one: the address follows the identity under which the mail
 * goes out (`identitySourceOf`, ADR-0023 no. 4). What is checked here is
 * not that *an* address is there, but that it is **not the other one**
 * — that is why `fakePublicUrls` records the calls.
 *
 * *Reproduction:* switch the `system` branch in `footerLinkFor` to
 * `resolveBaseUrl` → the second case goes red, and the footer of an
 * SPF/DKIM-signed mail of the installation would point at a host that the
 * administration of an arbitrary organisation has set.
 */
describe('QueuedBodyRenderer verlinkt in der Fußzeile ins System', () => {
  it('nimmt für eine Bestätigung die Adresse der Organisation — in beiden Fassungen', async () => {
    enforcedSettingsMock.mockReturnValue({ allowEdit: false } as FormSettings);
    const { service: publicUrls, baseCalls } = fakePublicUrls({
      tenant: 'https://ortsgruppe.test.invalid',
      installation: 'https://installation.test.invalid',
    });
    const renderer = new QueuedBodyRenderer(
      fakePrisma([null]),
      publicUrls,
      fakeSigning(),
    );

    const body = await renderer.render({
      id: 'mail-a',
      trigger: 'submit',
      tenantId: 'tenant-a',
      responseId: null,
      bodyText: 'Danke!',
      bodyHtml: '<p>Danke!</p>',
    });

    expect(baseCalls).toEqual(['tenant:tenant-a']);
    expect(body.text).toContain(
      'Formulare von „Ortsgruppe Musterstadt": https://ortsgruppe.test.invalid',
    );
    expect(body.text).not.toContain('installation.test.invalid');
    expect(body.html ?? '').toContain('href="https://ortsgruppe.test.invalid"');
    expect(body.html ?? '').not.toContain('installation.test.invalid');
  });

  it('nimmt für eine Systemmail die Adresse der Installation und fragt die Organisation nicht', async () => {
    enforcedSettingsMock.mockReturnValue({ allowEdit: false } as FormSettings);
    const { service: publicUrls, baseCalls } = fakePublicUrls({
      tenant: 'https://ortsgruppe.test.invalid',
      installation: 'https://installation.test.invalid',
    });
    const renderer = new QueuedBodyRenderer(
      fakePrisma([null]),
      publicUrls,
      fakeSigning(),
    );

    const body = await renderer.render({
      id: 'mail-a',
      // An account mail: it belongs to the installation (ADR-0023 no. 2).
      trigger: 'system',
      tenantId: 'tenant-a',
      responseId: null,
      bodyText: 'Hallo,\n\nfür dein Konto wurde ein Passwort gesetzt.\n',
      bodyHtml: null,
    });

    expect(baseCalls).toEqual(['installation']);
    expect(body.text).toContain(
      'Zu Formsache: https://installation.test.invalid',
    );
    expect(body.text).not.toContain('ortsgruppe.test.invalid');
    // ⚠️ **And the envelope does not carry the organisation at all** (a
    // review finding): on a system mail no organisation determines anything
    // (ADR-0023) — neither the address nor the name nor the colour. The
    // origin stands in the **body**, where ADR-0026 allows it.
    expect(body.text).not.toContain('Ortsgruppe Musterstadt');
    expect(body.text).toContain('Diese E-Mail wurde automatisch erzeugt.');
  });

  /**
   * The counter-check to the correction: the `tenant` row is **not read at
   * all** for a system mail. A double that throws on being read
   * is the only proof that a "we do not use the result anyway" does not
   * carry along.
   */
  it('liest für eine Systemmail die Organisationszeile gar nicht', async () => {
    enforcedSettingsMock.mockReturnValue({ allowEdit: false } as FormSettings);
    const { service: publicUrls } = fakePublicUrls({
      installation: 'https://installation.test.invalid',
    });
    const prisma = fakePrisma([null]);
    (
      prisma as unknown as { tenant: { findUnique: () => never } }
    ).tenant.findUnique = () => {
      throw new Error(
        'die tenant-Zeile darf für eine Systemmail nicht gelesen werden',
      );
    };
    const renderer = new QueuedBodyRenderer(prisma, publicUrls, fakeSigning());

    const body = await renderer.render({
      id: 'mail-a',
      trigger: 'system',
      tenantId: 'tenant-a',
      responseId: null,
      bodyText: 'Hallo,\n\nfür dein Konto wurde ein Passwort gesetzt.\n',
      bodyHtml: null,
    });

    expect(body.text).toContain(
      'Zu Formsache: https://installation.test.invalid',
    );
  });

  /**
   * **A mail without a link is better than one with a broken one** — and the
   * footer is not a load-bearing link: it may be missing without halting the
   * dispatch. That is the difference from the `kind: 'dead'` with which
   * `resetLinkFor` leaves an account mail lying without its authorisation.
   */
  it('verschickt ohne hinterlegte Adresse — ohne Link, ohne Fehler', async () => {
    enforcedSettingsMock.mockReturnValue({ allowEdit: false } as FormSettings);
    const { service: publicUrls } = fakePublicUrls();
    const renderer = new QueuedBodyRenderer(
      fakePrisma([null]),
      publicUrls,
      fakeSigning(),
    );

    const body = await renderer.render({
      id: 'mail-a',
      trigger: 'submit',
      tenantId: 'tenant-a',
      responseId: null,
      bodyText: 'Danke!',
      bodyHtml: '<p>Danke!</p>',
    });

    expect(body.text).toContain('Danke!');
    expect(body.text).toContain(
      'Ortsgruppe Musterstadt · Diese E-Mail wurde automatisch erzeugt.',
    );
    expect(body.text).not.toContain('http');
    expect(body.html ?? '').not.toContain('<a href');
  });
});
