import { Module } from '@nestjs/common';

import { MailClock, SystemMailClock } from './mail-clock';

/**
 * The queue's calendar, **and nothing else** — the module a consumer imports
 * when it needs the time the mail queue runs on but has no business with the
 * queue itself (the requirement; a review finding).
 *
 * ## Why this exists at all
 *
 * The public mail-sending budget needed one thing out of `MailModule` on the **public** path: the sending
 * budget counts `mail_log` rows over a sliding window and has to cut that
 * window with the same clock the worker and the purge read. So
 * `PublicFormsModule` imported `MailModule` „für `MailClock` und sonst nichts",
 * and the comment was true about the *intent* and false about the *graph*:
 * `MailModule` also exports `MailSecretsService` (which opens a sealed SMTP
 * password), `MailIdentityService` (whose `SendIdentity` carries that password
 * in the clear), `MailTransport` and `MAIL_TIMEOUTS`. All four became
 * injectable from the fill-in path a stranger reaches without a session — and
 * „der öffentliche Pfad kann nichts entschlüsseln" (* `CONTRIBUTING.md`) stopped being a fact about the import graph.
 *
 * An import is not a promise about which export gets used. This module makes
 * the promise checkable again: it provides one binding, exports one token, and
 * a public file that wants a mail secret now has to import a module that says
 * so in its own name.
 *
 * ## Why the binding lives here rather than in both places
 *
 * `MailModule` imports this module instead of binding `MailClock` a second
 * time, and that is the load-bearing half rather than tidiness. Two providers
 * for one abstract token are two *instances*: the worker would claim rows
 * against one calendar while the public path stamped `created_at` from another,
 * which is precisely the two-clock fault `mail-clock.ts` exists to rule out.
 * One binding, one clock, and a suite that moves it (`MutableClock`,
 * `test/mail/mail-test-context.ts`) still moves all of it.
 */
@Module({
  providers: [{ provide: MailClock, useClass: SystemMailClock }],
  exports: [MailClock],
})
export class MailClockModule {}
