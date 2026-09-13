import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService, INVALID_CREDENTIALS_MESSAGE } from './auth.service';
import { DUMMY_PASSWORD_HASH } from './dummy-password-hash';
import { verifyPassword } from './password';
import type { SessionFeaturesService } from './session-features.service';
import type { SessionService } from './session.service';

vi.mock('./password', () => ({ verifyPassword: vi.fn() }));

/**
 * The timing invariant of the requirement, asserted instead of measured.
 *
 * The integration suite times two logins against each other, and that
 * assertion is worth having — but a wall-clock comparison under CI load is a
 * blunt instrument: it can only say "roughly the same order of work", and it
 * says it from behind a whole HTTP stack. What actually has to hold is one
 * sentence about control flow: **the Argon2id verification runs even when
 * there is no user**. That is what this file pins down, deterministically and
 * without a database.
 *
 * If someone adds the obvious early `return` for an unknown address, the test
 * next door gets slower on one side and may or may not trip its bound. This
 * one fails outright.
 */
describe('AuthService.login', () => {
  const findUnique = vi.fn();
  const issue = vi.fn();

  const prisma = { user: { findUnique } } as unknown as PrismaService;
  const sessions = { issue } as unknown as SessionService;
  // No case here reaches the features of the session payload: every one of
  // them ends in a refusal before a payload comes into being.
  const service = new AuthService(
    prisma,
    sessions,
    {} as unknown as SessionFeaturesService,
  );

  const credentials = { email: 'niemand@example.org', password: 'geheim' };

  beforeEach(() => {
    vi.mocked(verifyPassword).mockReset();
    vi.mocked(verifyPassword).mockResolvedValue(false);
    findUnique.mockReset();
    issue.mockReset();
  });

  it('verifies against the dummy hash when no user was found', async () => {
    findUnique.mockResolvedValue(null);

    await expect(service.login(credentials)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(vi.mocked(verifyPassword)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(verifyPassword)).toHaveBeenCalledWith(
      DUMMY_PASSWORD_HASH,
      credentials.password,
    );
    // Nothing was opened, either.
    expect(issue).not.toHaveBeenCalled();
  });

  it('does the same for a user who has no password hash at all', async () => {
    // The OIDC case: the row exists, the hash does not.
    findUnique.mockResolvedValue({
      id: 'a',
      passwordHash: null,
      memberships: [],
    });

    await expect(service.login(credentials)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(vi.mocked(verifyPassword)).toHaveBeenCalledWith(
      DUMMY_PASSWORD_HASH,
      credentials.password,
    );
  });

  it('verifies against the stored hash when there is one', async () => {
    findUnique.mockResolvedValue({
      id: 'a',
      passwordHash: '$argon2id$stored',
      memberships: [],
    });

    await expect(service.login(credentials)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(vi.mocked(verifyPassword)).toHaveBeenCalledWith(
      '$argon2id$stored',
      credentials.password,
    );
  });

  /** One message for all three misses — the body half of the same guarantee. */
  it('answers all three misses with the identical message', async () => {
    const messages: string[] = [];
    for (const user of [
      null,
      { id: 'a', passwordHash: null, memberships: [] },
      { id: 'a', passwordHash: '$argon2id$stored', memberships: [] },
    ]) {
      findUnique.mockResolvedValue(user);
      await service.login(credentials).catch((error: unknown) => {
        messages.push(error instanceof Error ? error.message : String(error));
      });
    }

    expect(messages).toStrictEqual([
      INVALID_CREDENTIALS_MESSAGE,
      INVALID_CREDENTIALS_MESSAGE,
      INVALID_CREDENTIALS_MESSAGE,
    ]);
  });
});
