import { Logger } from '@nestjs/common';
import { TRASH_PURGE_BATCH_SIZE } from '@formsache/shared';
import { describe, expect, it, vi } from 'vitest';

import type { FileStorage } from '../files/file-storage';
import { FormRestriction } from '../tenancy/form-restriction';
import type { TenantScope } from '../tenancy/tenant-scope';
import { PermanentDeletionService } from './permanent-deletion.service';

/**
 * **„One item's failure never ends the run" — measured rather than commented**
 * (a review finding).
 *
 * The comment on `emptyTrash` has said that since the package was written, and
 * it was only true of the one failure the code caught: the storage refusing a
 * file. Every *database* error went straight out of the method — a `P2028` on a
 * form with thousands of answers hitting Prisma's default five-second bound, a
 * lock timeout, a dropped connection. The run ended as a 500, the deletions
 * already committed stayed committed, and the caller got no numbers at all.
 *
 * ## Why this one is a unit test and its neighbours are not
 *
 * Everything else about physical deletion is measured through the shipped
 * routes against a real PostgreSQL (`test/trash/permanent-delete.spec.ts`), and
 * for the rights and the isolation that is the only measurement worth having.
 * This property is different: it is about what happens when the **database
 * itself** refuses, and there is no way to make PostgreSQL refuse one item of a
 * run on purpose without the schema's own floors (`ON DELETE NO ACTION` on
 * `file`) getting in the way first — those exist precisely so that no request
 * can reach that state. What is under test here is the control flow of the run,
 * so the run is what is driven.
 *
 * The scope is a hand-built double and is cast **once**, with the cast named:
 * `TenantScope` is a bundle of nine delegates and this method touches three of
 * them.
 */

const RESTRICTED_USER = '019ff700-0000-7000-8000-000000000001';

/** What the double records and answers — everything `emptyTrash` can ask it. */
interface ScopeDouble {
  readonly formIds: string[];
  readonly responseKeys: { id: string; formId: string }[];
  readonly purgedForms: string[];
  readonly purgedResponses: string[];
  readonly failOn: Set<string>;
  readonly scope: TenantScope;
}

function scopeDouble(seed: {
  formIds?: string[];
  responseKeys?: { id: string; formId: string }[];
  /** Ids whose purge throws a database error rather than answering. */
  failOn?: string[];
}): ScopeDouble {
  const formIds = seed.formIds ?? [];
  const responseKeys = seed.responseKeys ?? [];
  const failOn = new Set(seed.failOn ?? []);
  const purgedForms: string[] = [];
  const purgedResponses: string[] = [];

  const refuse = (id: string): void => {
    if (failOn.has(id)) {
      // The shape Prisma reports a transaction that ran out of time as — the
      // very error a form with thousands of answers produces on the default
      // five-second bound.
      throw new Error(
        'Transaction API error: Transaction already closed (P2028)',
      );
    }
  };

  const parts = {
    forms: {
      deletedFormIds: (_where: unknown, take?: number) =>
        Promise.resolve(formIds.slice(0, take)),
      deletedResponseKeys: (_where: unknown, take?: number) =>
        Promise.resolve(responseKeys.slice(0, take)),
      countDeletedItems: () =>
        Promise.resolve(
          formIds.length -
            purgedForms.length +
            (responseKeys.length - purgedResponses.length),
        ),
      purgeForm: (id: string) => {
        refuse(id);
        purgedForms.push(id);
        return Promise.resolve(true);
      },
      purgeResponse: (where: { id: string }) => {
        refuse(where.id);
        purgedResponses.push(where.id);
        return Promise.resolve(true);
      },
    },
    files: {
      attachmentIdsOfForm: () => Promise.resolve([]),
      attachmentIdsOfResponse: () => Promise.resolve([]),
    },
    // Read by `FormRestriction.hiddenFormIdsIn` — nobody is restricted here.
    formPermissions: { findManyOfUser: () => Promise.resolve([]) },
    groups: { findById: () => Promise.resolve(null) },
  };

  return {
    formIds,
    responseKeys,
    purgedForms,
    purgedResponses,
    failOn,
    // The one cast, named: `TenantScope` bundles nine delegates and this
    // method reaches into three. Widening the double to the full type would be
    // eight stubs nothing calls, i.e. eight more things to keep in step with a
    // class this test says nothing about.
    scope: parts as unknown as TenantScope,
  };
}

/** An unrestricted caller — the fourth link is not what this file measures. */
function openRestriction(): FormRestriction {
  return new FormRestriction(
    RESTRICTED_USER,
    true,
    {
      canBuild: true,
      canViewResponses: true,
      canExport: true,
      canManageSettings: true,
      canManageFormSettings: true,
      canManageUsers: true,
    },
    { mode: 'all', permissions: ['canBuild', 'canViewResponses'] },
  );
}

function service(): PermanentDeletionService {
  // Nothing here removes a file — every double answers „no attachments".
  const storage = {
    remove: () => Promise.resolve(),
  } as unknown as FileStorage;
  const instance = new PermanentDeletionService(storage);
  // The warnings are the point of the code under test, not of its output.
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  return instance;
}

describe('Papierkorb leeren: one item’s failure never ends the run', () => {
  it('counts a database error as failed and carries on with the rest', async () => {
    const double = scopeDouble({
      formIds: ['form-1', 'form-2', 'form-3'],
      failOn: ['form-2'],
    });

    const result = await service().emptyTrash(double.scope, openRestriction());

    // Before the fix this call **threw**, so nothing below could be asserted:
    // the caller saw a 500 and the two forms that did go were gone with no
    // report of it.
    expect(result.forms).toBe(2);
    expect(result.failed).toBe(1);
    expect(double.purgedForms).toStrictEqual(['form-1', 'form-3']);
  });

  it('keeps going through a failing answer as well, and still counts what is left', async () => {
    const double = scopeDouble({
      responseKeys: [
        { id: 'answer-1', formId: 'form-1' },
        { id: 'answer-2', formId: 'form-1' },
        { id: 'answer-3', formId: 'form-1' },
      ],
      failOn: ['answer-1'],
    });

    const result = await service().emptyTrash(double.scope, openRestriction());

    expect(result.responses).toBe(2);
    expect(result.failed).toBe(1);
    // The failed one is still in the trash, which is what `remaining`
    // answers — pressing again takes it.
    expect(result.remaining).toBe(1);
  });

  it('takes at most one batch of items per call', async () => {
    const over = TRASH_PURGE_BATCH_SIZE + 5;
    const double = scopeDouble({
      responseKeys: Array.from({ length: over }, (_, index) => ({
        id: `answer-${String(index)}`,
        formId: 'form-1',
      })),
    });

    const result = await service().emptyTrash(double.scope, openRestriction());

    expect(result.responses).toBe(TRASH_PURGE_BATCH_SIZE);
    expect(double.purgedResponses).toHaveLength(TRASH_PURGE_BATCH_SIZE);
    expect(result.remaining).toBe(5);
  });

  it('spends the batch on forms first and gives the answers what is left of it', async () => {
    const forms = TRASH_PURGE_BATCH_SIZE - 2;
    const double = scopeDouble({
      formIds: Array.from(
        { length: forms },
        (_, index) => `form-${String(index)}`,
      ),
      responseKeys: Array.from({ length: 10 }, (_, index) => ({
        id: `answer-${String(index)}`,
        formId: 'other-form',
      })),
    });

    const result = await service().emptyTrash(double.scope, openRestriction());

    expect(result.forms).toBe(forms);
    // Exactly the remainder of the batch, not „ten because they were listed".
    expect(result.responses).toBe(2);
  });
});
