import request from 'supertest';
import { expect } from 'vitest';

import { SigningService } from '../../src/common/secret-box/signing.service';
import { recoverPasswordResetToken } from '../../src/auth/password-reset/password-reset-token';
import { apiPath, type TestApp } from './create-test-app';

/**
 * Redeems the invitation of a freshly created account (ADR-0024) — **through
 * the real route and with the real token**.
 *
 * ## Why the token is rebuilt here instead of coming from a mail
 *
 * Because it is in no column. The body in `mail_log` carries only the mark
 * (`PASSWORD_RESET_LINK_MARK`), and the address only comes into being in the
 * sending step — that is exactly the promise of ADR-0020 §5. A suite that could
 * fish the link out of the database would prove that the promise is broken.
 *
 * What happens here is therefore the same as in the sending step: the id of
 * the invitation row plus the signing key **of this application**
 * (`app.get(SigningService)`). A test that used its own key instead would
 * check its own arithmetic.
 *
 * ⚠️ The redemption goes through `POST /api/auth/password-reset/confirm` — the
 * one route that exists for it. That way it is also checked that an invitation
 * is redeemed by the same path as a reset.
 */
export async function redeemInvitation(
  app: TestApp,
  email: string,
  password: string,
): Promise<void> {
  const token = await invitationToken(app, email);
  const response = await request(app.server)
    .post(apiPath('/auth/password-reset/confirm'))
    .send({ token, password });
  expect(response.status).toBe(204);
}

/**
 * The value from a person's invitation link — without redeeming it.
 *
 * For the cases that want to see the link **fail** (second use, expired,
 * someone else's account).
 */
export async function invitationToken(
  app: TestApp,
  email: string,
): Promise<string> {
  const user = await app.prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  const row = await app.prisma.passwordResetToken.findFirstOrThrow({
    where: { userId: user.id, kind: 'invitation', usedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return recoverPasswordResetToken(app.app.get(SigningService), row.id);
}
