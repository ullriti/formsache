import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Cascade } from '../../test/css-cascade';
import { jsonResponse, stubFetch, type FetchMock } from '../../test/fetch-mock';
import { renderWithQuery } from '../../test/render-with-query';
import { TenantMembersTab } from './TenantMembersTab';

/** The ancestor `selector` names, or a failure that says which row was missing. */
function closestOrThrow(element: Element, selector: string): HTMLElement {
  const found = element.closest(selector);
  if (found === null) {
    throw new Error(`No ancestor matching „${selector}" was found.`);
  }
  return found as HTMLElement;
}

type FetchCall = FetchMock['mock']['calls'][number];

/** The first recorded call `predicate` accepts, or a failure naming what was asked for. */
function callOrThrow(
  fetchMock: FetchMock,
  predicate: (call: FetchCall) => boolean,
  description: string,
): FetchCall {
  const call = fetchMock.mock.calls.find(predicate);
  if (call === undefined) {
    throw new Error(`No recorded request matched: ${description}`);
  }
  return call;
}

/**
 * Nutzerrechte (tenant level) and the embedded group editor
 * (handoff).
 */

/**
 * The view's stylesheet, evaluated on the rendered tree — see
 * `test/css-cascade.ts`. `settings-view.css` belongs to it: the fields of the
 * box carry `.setting__control` from there, and without this file the cascade
 * would read every rule of it as not present.
 */
const styles = Cascade.fromFile(
  'src/views/settings-view.css',
  'src/views/tenant-admin/tenant-admin-view.css',
);

const TENANT_ID = '00000000-0000-4000-8000-0000000000a1';
// `z.uuid()` refuses anything that is not valid hex in every group — no `u`
// or `g` in these, unlike a hand-picked mnemonic suffix would invite.
const ADMIN_GROUP_ID = '00000000-0000-4000-8000-0000000000b1';
const EDITOR_GROUP_ID = '00000000-0000-4000-8000-0000000000b2';
const YOU_ID = '00000000-0000-4000-8000-0000000000c1';
const OTHER_ID = '00000000-0000-4000-8000-0000000000c2';

function adminGroup() {
  return {
    id: ADMIN_GROUP_ID,
    name: 'admin',
    color: '#7c0800',
    rank: 100,
    isSystem: true,
  };
}

function editorGroup() {
  return {
    id: EDITOR_GROUP_ID,
    name: 'editor',
    color: '#8a6a12',
    rank: 60,
    isSystem: false,
  };
}

function membersDocument() {
  return {
    members: [
      {
        userId: YOU_ID,
        email: 'you@musterstadt-stuttgart.de',
        name: 'Anna Admin',
        accountKind: 'local',
        group: adminGroup(),
      },
      {
        userId: OTHER_ID,
        email: 'erik@musterstadt-stuttgart.de',
        name: 'Erik Editor',
        accountKind: 'oidc',
        group: editorGroup(),
      },
    ],
  };
}

function groupsDocument() {
  return {
    groups: [
      {
        ...adminGroup(),
        permissions: {
          canBuild: true,
          canViewResponses: true,
          canExport: true,
          canManageSettings: true,
          canManageFormSettings: true,
          canManageUsers: true,
        },
        memberCount: 1,
      },
      {
        ...editorGroup(),
        permissions: {
          canBuild: true,
          canViewResponses: true,
          canExport: false,
          canManageSettings: false,
          canManageFormSettings: false,
          canManageUsers: false,
        },
        memberCount: 1,
      },
    ],
  };
}

function pathOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}

function routeFetch(options: {
  readonly members?: unknown;
  readonly groups?: unknown;
  readonly oidcEnabled?: boolean;
  readonly onGroupPut?: (id: string, body: unknown) => Response;
  readonly onMemberPost?: (body: unknown) => Response;
  readonly onInvitationPost?: (url: string) => Response;
}) {
  const members = options.members ?? membersDocument();
  const groups = options.groups ?? groupsDocument();

  return stubFetch().mockImplementation((input, init) => {
    const url = pathOf(input);
    const method = init?.method ?? 'GET';

    if (url.endsWith('/tenant/users') && method === 'GET') {
      return Promise.resolve(jsonResponse(200, members));
    }
    if (url.endsWith('/tenant/users') && method === 'POST') {
      if (options.onMemberPost !== undefined) {
        return Promise.resolve(options.onMemberPost(bodyOf(init)));
      }
      return Promise.resolve(
        jsonResponse(200, {
          userId: '00000000-0000-4000-8000-0000000000c9',
          email: 'neu@musterstadt-stuttgart.de',
          name: 'Neue Person',
          accountKind: 'local',
          // A freshly created account gets an invitation; an existing one that
          // is merely attached does not (`invited: false`).
          invited: true,
          group: editorGroup(),
        }),
      );
    }
    if (url.includes('/tenant/users/') && method === 'PUT') {
      return Promise.resolve(jsonResponse(200, membersDocument().members[1]));
    }
    if (url.includes('/tenant/users/') && method === 'DELETE') {
      return Promise.resolve(jsonResponse(204, undefined));
    }
    if (url.includes('/invitation') && method === 'POST') {
      if (options.onInvitationPost !== undefined) {
        return Promise.resolve(options.onInvitationPost(url));
      }
      return Promise.resolve(jsonResponse(204, undefined));
    }
    if (url.endsWith('/tenant/groups') && method === 'GET') {
      return Promise.resolve(jsonResponse(200, groups));
    }
    if (url.endsWith('/tenant/groups') && method === 'POST') {
      const write = bodyOf(init) as Record<string, unknown>;
      return Promise.resolve(
        jsonResponse(200, {
          id: '00000000-0000-4000-8000-0000000000b9',
          name: write.name,
          color: write.color,
          rank: write.rank,
          isSystem: false,
          permissions: write.permissions,
          memberCount: 0,
        }),
      );
    }
    if (url.includes('/tenant/groups/') && method === 'DELETE') {
      return Promise.resolve(jsonResponse(204, undefined));
    }
    if (url.includes('/tenant/groups/') && method === 'PUT') {
      const id = url.split('/tenant/groups/')[1] ?? '';
      if (options.onGroupPut !== undefined) {
        return Promise.resolve(options.onGroupPut(id, bodyOf(init)));
      }
      const write = bodyOf(init) as Record<string, unknown>;
      return Promise.resolve(
        jsonResponse(200, {
          id,
          name: write.name,
          color: write.color,
          rank: write.rank,
          isSystem: false,
          permissions: write.permissions,
          memberCount: 1,
        }),
      );
    }
    if (url.endsWith('/tenant/oidc')) {
      return Promise.resolve(
        jsonResponse(200, {
          enabled: options.oidcEnabled ?? true,
          issuer: 'https://sso.example.de/',
          clientId: 'client',
          scopes: ['openid'],
          emailClaim: 'email',
          emailVerifiedClaim: 'email_verified',
          buttonLabel: null,
          clientSecretSet: false,
          redirectUri: 'https://formular.example.de/api/auth/oidc/callback/x',
        }),
      );
    }
    return Promise.resolve(jsonResponse(404, { message: 'not found' }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Nutzerrechte (Tenant-Ebene)', () => {
  it('lists every member with their OIDC/Lokal badge, and marks „Sie"', async () => {
    routeFetch({});
    renderWithQuery(
      <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Anna Admin')).toBeDefined();
    });

    const you = closestOrThrow(screen.getByText('Anna Admin'), 'li');
    expect(within(you).getByText('Sie')).toBeDefined();
    expect(within(you).getByText('Lokal')).toBeDefined();

    const other = closestOrThrow(screen.getByText('Erik Editor'), 'li');
    expect(within(other).getByText('OIDC')).toBeDefined();
    expect(
      within(other).getByRole<HTMLSelectElement>('combobox').disabled,
    ).toBe(false);
    expect(
      within(other).getByRole('button', { name: /entfernen/i }),
    ).toBeDefined();
  });

  /**
   * An unclaimed SSO invitation gets its own badge, not the OIDC badge's
   * appearance a third time. Reverting `accountKind: 'invited'`
   * back onto `'oidc'` — at the schema, at `deriveAccountKind`, or here — makes
   * this red: „Eingeladen" would either not render at all (schema refuses the
   * value) or render as „OIDC" (badge falls back to its two-value switch).
   */
  it('marks an unclaimed SSO invitation as „Eingeladen", not „OIDC"', async () => {
    const invitedId = '00000000-0000-4000-8000-0000000000c3';
    routeFetch({
      members: {
        members: [
          ...membersDocument().members,
          {
            userId: invitedId,
            email: 'warte@musterstadt-stuttgart.de',
            name: 'Ines Invited',
            accountKind: 'invited',
            group: editorGroup(),
          },
        ],
      },
    });
    renderWithQuery(
      <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Ines Invited')).toBeDefined();
    });

    const invited = closestOrThrow(screen.getByText('Ines Invited'), 'li');
    expect(within(invited).getByText('Eingeladen')).toBeDefined();
    expect(within(invited).queryByText('OIDC')).toBeNull();
  });

  /**
   * The server refuses exactly one case — the **last** administrator of an organisation
   * — so the page must not refuse more. The prototype's greyed-out select and
   * missing „Entfernen" on one's own row looked like a rule and was none: an
   * admin with colleagues may step down or leave, and a surface that forbids it
   * is a surface that lies about who decides.
   */
  it('lets you change and remove your own membership, after a confirmation', async () => {
    const fetchMock = routeFetch({});
    renderWithQuery(
      <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Anna Admin')).toBeDefined();
    });

    const you = closestOrThrow(screen.getByText('Anna Admin'), 'li');
    expect(within(you).getByRole<HTMLSelectElement>('combobox').disabled).toBe(
      false,
    );

    fireEvent.change(within(you).getByRole('combobox'), {
      target: { value: EDITOR_GROUP_ID },
    });
    // Nothing is written before the question is answered.
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
    ).toBe(false);
    expect(within(you).getByText(/Ihre eigene Rolle/)).toBeDefined();

    fireEvent.click(within(you).getByRole('button', { name: 'Rolle ändern' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT'),
      ).toBe(true);
    });
  });

  it('asks before removing a member, and only then deletes', async () => {
    const fetchMock = routeFetch({});
    renderWithQuery(
      <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Erik Editor')).toBeDefined();
    });

    const row = closestOrThrow(screen.getByText('Erik Editor'), 'li');
    fireEvent.click(
      screen.getByRole('button', { name: 'Erik Editor entfernen' }),
    );
    // The first click asks; the loss is not undoable, so it is not the write.
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE'),
    ).toBe(false);

    fireEvent.click(within(row).getByRole('button', { name: 'Entfernen' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE'),
      ).toBe(true);
    });
  });

  /**
   * **Konzept no. 69 stands in the dialog — conditionally, and without giving
   * away other organizations' memberships.**
   *
   * Whoever is removed from their last organization loses their account. That
   * belongs said. But “this person is in no other organization” is itself a
   * cross-organization piece of information — precisely the boundary this
   * project defends everywhere else. The test therefore checks **both**: that
   * the consequence stands there, and that it stands there as a condition,
   * without anything having been queried. A `GET` on a membership list of other
   * organizations would be the finding, not the evidence.
   */
  it('names the account loss conditionally, without asking about other Organisationen', async () => {
    const fetchMock = routeFetch({});
    renderWithQuery(
      <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Erik Editor')).toBeDefined();
    });

    const row = closestOrThrow(screen.getByText('Erik Editor'), 'li');
    fireEvent.click(
      screen.getByRole('button', { name: 'Erik Editor entfernen' }),
    );

    const question = within(row).getByText(
      /Ist dies ihre letzte Organisation und verwaltet sie das System nicht, wird auch ihr Konto gelöscht/,
    );
    expect(question).toBeDefined();
    // Nothing asserting: neither “no further membership” nor a number — the
    // statement stays a condition.
    expect(question.textContent).not.toMatch(
      /anderen Organisation|keine weitere/,
    );

    // And no request that could have resolved the condition.
    const asked = fetchMock.mock.calls.map(([input]) => {
      if (typeof input === 'string') {
        return input;
      }
      return input instanceof URL ? input.href : input.url;
    });
    expect(asked.some((url) => /membership|users\/.+\/tenants/.test(url))).toBe(
      false,
    );
  });

  /** The same condition for one's own row — there in the first person. */
  it('says the same about your own last Organisation', async () => {
    routeFetch({});
    renderWithQuery(
      <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Anna Admin')).toBeDefined();
    });

    const you = closestOrThrow(screen.getByText('Anna Admin'), 'li');
    fireEvent.click(
      screen.getByRole('button', { name: 'Anna Admin entfernen' }),
    );

    expect(
      within(you).getByText(
        /Ist dies deine letzte Organisation und verwaltest du das System nicht, wird auch dein Konto gelöscht/,
      ),
    ).toBeDefined();
  });

  it('takes „Abbrechen" as an answer', async () => {
    const fetchMock = routeFetch({});
    renderWithQuery(
      <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Erik Editor')).toBeDefined();
    });

    const row = closestOrThrow(screen.getByText('Erik Editor'), 'li');
    fireEvent.click(
      screen.getByRole('button', { name: 'Erik Editor entfernen' }),
    );
    fireEvent.click(within(row).getByRole('button', { name: 'Abbrechen' }));

    expect(within(row).queryByRole('button', { name: 'Entfernen' })).toBeNull();
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE'),
    ).toBe(false);
  });

  describe('Person hinzufügen', () => {
    it('locks the OIDC option once the organisation is known to have SSO off', async () => {
      routeFetch({ oidcEnabled: false });
      renderWithQuery(
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'OIDC-Konto (SSO)' }),
        ).toBeDefined();
      });

      expect(
        screen.getByRole<HTMLButtonElement>('button', {
          name: 'OIDC-Konto (SSO)',
        }).disabled,
      ).toBe(true);
      expect(
        screen.getByText(
          /OIDC-Anmeldung ist für diese Organisation deaktiviert/,
        ),
      ).toBeDefined();
    });

    /**
     * **The address is the one-time matching key** at the first
     * SSO login (ADR-0012 no. 3): if it does not match exactly what the login
     * service reports as verified, the login is refused with “no account” —
     * deliberately with the same message as “no invitation”, which leaves
     * support blind. The hint therefore hangs on the field
     * (`aria-describedby`) and not in a `title`, which only the mouse reaches.
     */
    it('ties the exact-address hint to the e-mail field, for an OIDC invitation', async () => {
      routeFetch({});
      renderWithQuery(
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'OIDC-Konto (SSO)' }),
        ).toBeDefined();
      });
      fireEvent.click(screen.getByRole('button', { name: 'OIDC-Konto (SSO)' }));

      const field = screen.getByLabelText('E-Mail-Adresse');
      const hint = screen.getByText(
        /muss exakt der Adresse entsprechen, die der\s+Anmeldedienst als verifiziert meldet/,
      );
      expect(field.getAttribute('aria-describedby')).toBe(hint.id);
      expect(field.getAttribute('title')).toBeNull();

      // For a local account the address is no matching key — so nothing stands
      // there claiming that either.
      fireEvent.click(screen.getByRole('button', { name: 'Lokaler Nutzer' }));
      expect(
        screen
          .getByLabelText('E-Mail-Adresse')
          .getAttribute('aria-describedby'),
      ).toBeNull();
    });

    it('creates a local account with name, e-mail and group — and no password', async () => {
      const fetchMock = routeFetch({});
      renderWithQuery(
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
      );

      await waitFor(() => {
        expect(screen.getByLabelText('Name')).toBeDefined();
      });

      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'Neue Person' },
      });
      fireEvent.change(screen.getByLabelText('E-Mail-Adresse'), {
        target: { value: 'neu@musterstadt-stuttgart.de' },
      });
      // **There is no password field** (ADR-0024) — and the block says what
      // happens instead.
      expect(screen.queryByLabelText('Passwort')).toBeNull();
      expect(
        screen.getByText(/bekommt eine Einladung per Mail/u),
      ).toBeDefined();

      fireEvent.click(screen.getByRole('button', { name: 'Hinzufügen' }));

      await waitFor(() => {
        expect(screen.getByText(/wurde hinzugefügt/)).toBeDefined();
      });

      const post = callOrThrow(
        fetchMock,
        ([, init]) => init?.method === 'POST',
        'POST /tenant/users',
      );
      const body = bodyOf(post[1]) as Record<string, unknown>;
      // The whole payload, `groupId` included: the field decides what the new
      // person may do, and a `toMatchObject` without it stayed green while the
      // form handed out `admin` (the list arrives by rank *descending*, so
      // `groups[0]` is the most powerful group there is).
      expect(body).toEqual({
        kind: 'local',
        name: 'Neue Person',
        email: 'neu@musterstadt-stuttgart.de',
        groupId: EDITOR_GROUP_ID,
      });
      // The name field is cleared for the next entry — a flash message stands
      // in for it instead of leaving stale text on screen.
      expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('');
      // And the message says that an invitation went out — the case the next
      // test checks from the other side.
      expect(
        screen.getByText(/hat eine Einladung per Mail bekommen/u),
      ).toBeDefined();
    });

    /**
     * **An existing account gets no invitation — and the message now says so
     * too.**
     *
     * If an address is added that already exists, the server writes only a
     * membership (`attachExisting`) and queues **nothing**: the person signs in
     * with the password they have had all along. The page reported „hat eine
     * Einladung per Mail bekommen" all the same, because the response did not
     * tell the two cases apart — found while bringing the E2E runs up to date.
     * Since then it carries `invited`, and this case records that the interface
     * listens to it instead of guessing.
     */
    it('sagt bei einem bereits vorhandenen Konto, dass keine Einladung hinausgeht', async () => {
      routeFetch({
        onMemberPost: () =>
          jsonResponse(200, {
            userId: '00000000-0000-4000-8000-0000000000ca',
            email: 'schon-da@musterstadt-stuttgart.de',
            name: 'Schon Da',
            accountKind: 'local',
            invited: false,
            group: editorGroup(),
          }),
      });
      renderWithQuery(
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
      );

      await waitFor(() => {
        expect(screen.getByLabelText('Name')).toBeDefined();
      });
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'Schon Da' },
      });
      fireEvent.change(screen.getByLabelText('E-Mail-Adresse'), {
        target: { value: 'schon-da@musterstadt-stuttgart.de' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Hinzufügen' }));

      await waitFor(() => {
        expect(screen.getByText(/wurde hinzugefügt/u)).toBeDefined();
      });
      expect(screen.getByText(/vorhandenen Passwort/u)).toBeDefined();
      expect(screen.queryByText(/Einladung per Mail bekommen/u)).toBeNull();
    });

    /**
     * **Derselbe Satz wäre für ein SSO-Konto falsch** — und das ist der Fall,
     * aus dem die Unterscheidung überhaupt entstand (Review-Runde 3 Nr. 13).
     *
     * Die Lage: `user.email` ist installationsweit eindeutig, es gibt also
     * **ein** Konto, und eine zweite Organisation hängt sich nur eine
     * Mitgliedschaft daran (ADR-0012 Nr. 3). Die Bindung bleibt das Paar
     * *(Issuer, Subject)*, das beim ersten Login entstand — trägt diese
     * Organisation einen anderen Anmeldedienst ein, erreicht deren
     * Schaltfläche dieses Konto nie (`oidc-identity.service.ts`: „a second
     * provider cannot claim it"). Die Person meldet sich weiter dort an, wo
     * das Konto entstand, und wechselt danach hierher.
     *
     * „Die Anmeldung läuft mit dem vorhandenen Passwort" wäre für ein solches
     * Konto schlicht falsch: es hat keines. Wer der Meldung glaubte, wartete
     * auf ein Passwort, das nie kommt, und suchte den Fehler in der eigenen
     * SSO-Einrichtung.
     *
     * Der Zweig stand ungetestet; dieser Test ist sein Regressionstest.
     */
    it('nennt bei einem vorhandenen SSO-Konto den Anmeldedienst statt eines Passworts', async () => {
      routeFetch({
        onMemberPost: () =>
          jsonResponse(200, {
            userId: '00000000-0000-4000-8000-0000000000cb',
            email: 'sso-schon-da@musterstadt-stuttgart.de',
            name: 'SSO Schon Da',
            accountKind: 'oidc',
            invited: false,
            group: editorGroup(),
          }),
      });
      renderWithQuery(
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
      );

      await waitFor(() => {
        expect(screen.getByLabelText('Name')).toBeDefined();
      });
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'SSO Schon Da' },
      });
      fireEvent.change(screen.getByLabelText('E-Mail-Adresse'), {
        target: { value: 'sso-schon-da@musterstadt-stuttgart.de' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Hinzufügen' }));

      await waitFor(() => {
        expect(screen.getByText(/wurde hinzugefügt/u)).toBeDefined();
      });
      expect(
        screen.getByText(
          /meldet sich weiterhin über den Anmeldedienst an, bei dem es entstanden ist/u,
        ),
      ).toBeDefined();
      // **Das Gegenteil ist der Punkt:** ein SSO-Konto hat kein Passwort, und
      // die Meldung darf keines versprechen.
      expect(screen.queryByText(/vorhandenen Passwort/u)).toBeNull();
      expect(screen.queryByText(/Einladung per Mail bekommen/u)).toBeNull();
    });

    /**
     * **The expanded role select could not be read** (finding 14).
     *
     * The „Person hinzufügen" box stands on `--color-ink`, and its fields set
     * light type on 6 % white. The closed field agreed with that; the
     * *expanded* menu, however, is drawn by the browser on its own ground — and
     * `base.css` puts the page on `color-scheme: light`, that is on white.
     * Light type on light ground: the roles stood there, they could not be
     * read.
     *
     * Measured against the cascade and not against a string in the stylesheet:
     * a rule that stands there and does not take hold on this element is
     * exactly the error this is about.
     */
    it('zeichnet die Rollenauswahl auch aufgeklappt hell auf dunkel', async () => {
      routeFetch({});
      renderWithQuery(
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
      );

      await waitFor(() => {
        expect(screen.getByLabelText('Rolle')).toBeDefined();
      });

      const select = screen.getByLabelText('Rolle');
      // The request to the browser…
      expect(styles.declaredValue(select, 'color-scheme')).toBe('dark');

      // …and the statement for the browsers that ignore it. Opaque colours:
      // the menu lies over the page, not on the dark box, and a white
      // percentage would there again have the browser's ground beneath it.
      const option = within(select).getAllByRole('option')[0];
      expect(option).toBeDefined();
      expect(styles.declaredValue(option as Element, 'background-color')).toBe(
        '#201f24',
      );
      expect(styles.declaredValue(option as Element, 'color')).toBe('#f3efe6');
    });

    it('lässt die Zeilen-Auswahl der Mitgliederliste hell, wie sie war', async () => {
      // The counter-check, without which the assertion above would be green
      // even if the rule coloured every select of the view dark: this one
      // stands **outside** the box on white ground, and there the browser's
      // default ground is the right one.
      routeFetch({});
      renderWithQuery(
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
      );

      await waitFor(() => {
        expect(screen.getByText('Erik Editor')).toBeDefined();
      });

      const row = closestOrThrow(screen.getByText('Erik Editor'), 'li');
      const select = within(row).getByRole('combobox');
      expect(select.className).toContain('tenant-admin__role-select');
      expect(styles.declaredValue(select, 'color-scheme')).toBeUndefined();

      const option = within(select).getAllByRole('option')[0];
      expect(option).toBeDefined();
      expect(
        styles.declaredValue(option as Element, 'background-color'),
      ).toBeUndefined();
      expect(styles.declaredValue(option as Element, 'color')).toBeUndefined();
    });

    /**
     * **The hint stuck to the button** (finding 15).
     *
     * Two sentences stand in the same place: the success message after creating
     * and, as long as nothing has been created, the hint about the kind of
     * account. The message had a margin at the top, the hint did not — the same
     * place, two margins, depending on which sentence was up at the time.
     */
    it('gibt dem Kontoart-Hinweis denselben Abstand wie der Erfolgsmeldung', async () => {
      routeFetch({});
      renderWithQuery(
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
      );

      await waitFor(() => {
        expect(screen.getByText(/^Lokaler Nutzer:/u)).toBeDefined();
      });

      // The same margin the success message already had in this place.
      expect(
        styles.pixels(screen.getByText(/^Lokaler Nutzer:/u), 'margin-top'),
      ).toBe(8);

      // And the same sentence from the finding, in its other version.
      fireEvent.click(screen.getByRole('button', { name: 'OIDC-Konto (SSO)' }));
      expect(
        styles.pixels(screen.getByText(/^OIDC-Nutzer:/u), 'margin-top'),
      ).toBe(8);

      /*
       * The hints **inside** the fields, by contrast, stay where they were: the
       * field box brings its margin along already, a second one would be a
       * hole. The child selector must therefore not reach into a field.
       *
       * Measured at the address hint of the OIDC version, since this block's
       * password field along with its „Mindestens …" hint is gone (ADR-0024):
       * the same statement, a different element — 6 px from `.setting__note`,
       * not the 8 px the child selector hands out.
       */
      expect(
        styles.pixels(
          screen.getByText(/^Diese Adresse muss exakt/u),
          'margin-top',
        ),
      ).toBe(6);
    });
  });

  describe('Gruppen & Rechte', () => {
    it('shows the permission pills of a group, and the count', async () => {
      routeFetch({});
      renderWithQuery(
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
      );

      await waitFor(() => {
        expect(screen.getByText('2/6 Rechte')).toBeDefined();
      });
      expect(screen.getByText('6/6 Rechte')).toBeDefined();
    });

    /**
     * The pill is a real `<button>`, not a decoration next to an invisible
     * control — the same defect class found for the settings switch (only
     * the rim toggled, not the middle) does not apply here, but the click is
     * still asserted against the exact element with the accessible name,
     * never against a wrapping `<div>`.
     */
    it('toggles a permission by clicking the pill itself, and saves the whole group', async () => {
      const fetchMock = routeFetch({});
      renderWithQuery(
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
      );

      await waitFor(() => {
        expect(screen.getByText('2/6 Rechte')).toBeDefined();
      });

      const editorCard = closestOrThrow(
        screen.getByLabelText('Name der Gruppe editor'),
        '.tenant-admin__group-card',
      );
      const exportPill = within(editorCard).getByRole('button', {
        name: 'Export',
      });
      fireEvent.click(exportPill);
      expect(within(editorCard).getByText('3/6 Rechte')).toBeDefined();

      fireEvent.click(
        within(editorCard).getByRole('button', { name: 'Speichern' }),
      );

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(
            ([url, init]) =>
              pathOf(url).includes(`/tenant/groups/${EDITOR_GROUP_ID}`) &&
              init?.method === 'PUT',
          ),
        ).toBe(true);
      });
      const write = callOrThrow(
        fetchMock,
        ([url, init]) =>
          pathOf(url).includes(`/tenant/groups/${EDITOR_GROUP_ID}`) &&
          init?.method === 'PUT',
        `PUT /tenant/groups/${EDITOR_GROUP_ID}`,
      );
      const body = bodyOf(write[1]) as {
        readonly permissions: Record<string, boolean>;
      };
      expect(body.permissions.canExport).toBe(true);
    });

    /**
     * **A group colour that breaks the contrast is reported — not
     * refused** .
     *
     * The case the decision for the rights matrix names expressly: there the
     * group name stands in exactly this colour as **type** on white, and the
     * seed colours are the only thing that makes that harmless today
     * (`color-contrast.ts` works it out). The counter-check next to it is the
     * actual assertion: with the seed colour **no** sentence stands there.
     */
    it('meldet eine helle Gruppenfarbe, ohne das Speichern zu verhindern', async () => {
      const fetchMock = routeFetch({});
      renderWithQuery(
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
      );

      await waitFor(() => {
        expect(screen.getByText('2/6 Rechte')).toBeDefined();
      });

      const editorCard = closestOrThrow(
        screen.getByLabelText('Name der Gruppe editor'),
        '.tenant-admin__group-card',
      );

      // The seed's editor gold reaches 5,06:1 — nothing to report.
      expect(within(editorCard).queryByText('Schrift:')).toBeNull();

      const picker =
        within(editorCard).getByLabelText<HTMLInputElement>('Farbe von editor');
      expect(picker.getAttribute('aria-describedby')).toBeNull();

      // A light green: as a surface effortlessly readable (9,48:1), as type in
      // the rights matrix almost nothing (1,77:1).
      fireEvent.change(picker, { target: { value: '#9bd18a' } });

      expect(within(editorCard).getByText('Schrift:')).toBeDefined();
      expect(within(editorCard).queryByText('Fläche:')).toBeNull();
      expect(within(editorCard).getByText(/Rechte-Matrix/u)).toBeDefined();
      // The message hangs on the input, not next to it.
      expect(picker.getAttribute('aria-describedby')).not.toBeNull();

      // And it locks nothing: the colour goes to the server unchanged.
      fireEvent.click(
        within(editorCard).getByRole('button', { name: 'Speichern' }),
      );
      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(
            ([url, init]) =>
              pathOf(url).includes(`/tenant/groups/${EDITOR_GROUP_ID}`) &&
              init?.method === 'PUT',
          ),
        ).toBe(true);
      });
      const write = callOrThrow(
        fetchMock,
        ([url, init]) =>
          pathOf(url).includes(`/tenant/groups/${EDITOR_GROUP_ID}`) &&
          init?.method === 'PUT',
        `PUT /tenant/groups/${EDITOR_GROUP_ID}`,
      );
      expect((bodyOf(write[1]) as { readonly color: string }).color).toBe(
        '#9bd18a',
      );
    });

    /**
     * **Auskunft statt abgeschalteter Bedienelemente** (a rule this application follows): the
     * system group's card says what the group is and what it holds, and offers
     * nothing. A `disabled` colour picker, name field, rank field and five
     * `disabled` pills are seven promises of a function that does not exist —
     * the server refuses the write outright.
     *
     * The card is queried **by name** here. The earlier version looked for a
     * button named „Gruppe löschen", which matches no card at all: the delete
     * button's accessible name is „Gruppe <name> löschen". A test that asks for
     * something nothing is called can only ever be green, and it would have
     * stayed green with a delete button added to this very card — the
     * reproduction the review asked for.
     */
    it('gives the system group information instead of controls', async () => {
      routeFetch({});
      renderWithQuery(
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
      );

      await waitFor(() => {
        expect(screen.getByText('6/6 Rechte')).toBeDefined();
      });

      const adminCard = closestOrThrow(
        screen.getByText('System · alle Rechte'),
        '.tenant-admin__group-card',
      );
      // The name is text, not a field somebody may type in.
      expect(within(adminCard).getByText('admin')).toBeDefined();
      expect(within(adminCard).queryByLabelText('Name der Gruppe admin')).toBe(
        null,
      );
      expect(
        within(adminCard).queryByRole('button', {
          name: 'Gruppe admin löschen',
        }),
      ).toBeNull();
      // Neither an editable pill nor a disabled one — the six rights are shown
      // as what they are, an answer.
      expect(within(adminCard).queryAllByRole('button')).toHaveLength(0);
      expect(within(adminCard).getByText('Nutzer verwalten')).toBeDefined();
      expect(
        within(adminCard).queryByRole('button', { name: 'Speichern' }),
      ).toBeNull();
    });

    it('asks before deleting a group', async () => {
      const fetchMock = routeFetch({});
      renderWithQuery(
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
      );

      await waitFor(() => {
        expect(screen.getByText('2/6 Rechte')).toBeDefined();
      });

      const editorCard = closestOrThrow(
        screen.getByLabelText('Name der Gruppe editor'),
        '.tenant-admin__group-card',
      );
      fireEvent.click(
        within(editorCard).getByRole('button', {
          name: 'Gruppe editor löschen',
        }),
      );
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE'),
      ).toBe(false);

      fireEvent.click(
        within(editorCard).getByRole('button', { name: 'Gruppe löschen' }),
      );
      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE'),
        ).toBe(true);
      });
    });

    /**
     * A new group starts **below** every existing one. The hard-coded `rank: 10`
     * it used to send collided with whatever an organisation already had there, and two
     * groups at one rank make “who is higher” — and with it the per-form cap of
     * the requirement — ambiguous.
     */
    it('derives the rank of a new group from the ones that exist', async () => {
      const fetchMock = routeFetch({});
      renderWithQuery(
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: '+ Gruppe hinzufügen' }),
        ).toBeDefined();
      });

      fireEvent.click(
        screen.getByRole('button', { name: '+ Gruppe hinzufügen' }),
      );

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(
            ([url, init]) =>
              pathOf(url).endsWith('/tenant/groups') && init?.method === 'POST',
          ),
        ).toBe(true);
      });
      const post = callOrThrow(
        fetchMock,
        ([url, init]) =>
          pathOf(url).endsWith('/tenant/groups') && init?.method === 'POST',
        'POST /tenant/groups',
      );
      // The organisation's lowest rank is „editor" at 60.
      expect((bodyOf(post[1]) as Record<string, unknown>).rank).toBe(59);
    });
  });

  /**
   * **„Einladung erneut senden"** (ADR-0024).
   *
   * The button stands next to **every** member, and that is a decision: the
   * list does not know whether an account has already set its password
   * (`tenantMemberSchema` does not carry that, and `MEMBER_VIEW_SELECT`
   * deliberately does not read the hash). So the same construction as with the
   * address change — the server answers with its own sentence when it does not
   * work.
   *
   * *Counter-check:* change the route in the hook to
   * `/tenant/users/:id/password` → the first case goes red, because the address
   * checked is a different one.
   */
  describe('Einladung erneut senden', () => {
    it('schickt einen Rumpf-losen POST auf die Einladungs-Route', async () => {
      const fetchMock = routeFetch({});
      renderWithQuery(
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
      );

      await waitFor(() => {
        expect(screen.getByText('Erik Editor')).toBeDefined();
      });

      const row = closestOrThrow(screen.getByText('Erik Editor'), 'li');
      fireEvent.click(
        within(row).getByRole('button', { name: 'Erik Editor bearbeiten' }),
      );
      fireEvent.click(
        within(row).getByRole('button', { name: 'Einladung erneut senden' }),
      );

      await waitFor(() => {
        expect(screen.getByText(/Einladung an .* verschickt/u)).toBeDefined();
      });

      const post = callOrThrow(
        fetchMock,
        ([url, init]) =>
          pathOf(url).endsWith('/invitation') && init?.method === 'POST',
        'POST /tenant/users/:id/invitation',
      );
      // **No recipient in the body**, and that is half the security statement
      // of this route: the mail goes to the stored address. A field for it
      // would be a way to send the authority over somebody else's account into
      // a mailbox of one's own choosing.
      expect(post[1]?.body).toBeUndefined();
    });

    it('zeigt die Absage des Servers, statt eine eigene zu erfinden', async () => {
      routeFetch({
        onInvitationPost: () =>
          jsonResponse(422, {
            message: 'Dieses Konto ist bereits eingerichtet.',
          }),
      });
      renderWithQuery(
        <TenantMembersTab tenantId={TENANT_ID} currentUserId={YOU_ID} />,
      );

      await waitFor(() => {
        expect(screen.getByText('Erik Editor')).toBeDefined();
      });

      const row = closestOrThrow(screen.getByText('Erik Editor'), 'li');
      fireEvent.click(
        within(row).getByRole('button', { name: 'Erik Editor bearbeiten' }),
      );
      fireEvent.click(
        within(row).getByRole('button', { name: 'Einladung erneut senden' }),
      );

      await waitFor(() => {
        expect(
          screen.getByText('Dieses Konto ist bereits eingerichtet.'),
        ).toBeDefined();
      });
    });
  });
});
