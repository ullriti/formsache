import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import type { ApiEnv } from '@formsache/shared';
import { describe, expect, it } from 'vitest';

import { API_ENV } from '../../src/config/env';
import { FileStorage } from '../../src/files/file-storage';
import { FileStorageModule } from '../../src/files/file-storage.module';
import { LocalFileStorage } from '../../src/files/local-file-storage';
import { MailClock, SystemMailClock } from '../../src/mail/mail-clock';
import { MailClockModule } from '../../src/mail/mail-clock.module';

/**
 * **„Ein Binding, ein Token" wird bewacht, nicht vorgenommen** (ADR-0014,
 * „Der öffentliche Pfad", Punkt 4).
 *
 * The finding was not that somebody did not know the rule — the
 * comment on `PublicFormsModule` claimed it in as many words. It was that
 * **nothing checked it**: the module imported `MailModule` „für die Uhr" and
 * received `MailSecretsService`, `MailIdentityService` and `MailTransport` with
 * it, all three injectable from a route strangers reach without a session.
 * `MailClockModule` was built as the answer and has never had a test on its
 * `exports` since — a second entry there would go unnoticed to this day.
 *
 * A build rule without a test is that same mistake in a different module, so
 * this file measures the shape of the module the public path will import for
 * the storage, **and** retrofits the same measurement onto the
 * module that established the shape.
 *
 * *Reproduction (run for both):* additionally exporting the concrete adapter
 * turns both assertions of that module red.
 */

/**
 * The `exports` of a module, read from the metadata Nest itself reads.
 *
 * Not counted from the source file: a reviewer counting entries in a diff is
 * exactly the mechanism that failed before. `@Module()` writes its four keys as
 * plain metadata, and `'exports'` is the one Nest resolves against.
 */
function exportsOf(module: unknown): unknown[] {
  const declared: unknown = Reflect.getMetadata('exports', module as object);
  return Array.isArray(declared) ? declared : [];
}

const TEST_ENV = {
  FILE_STORAGE_DIR: '/nonexistent-on-purpose',
} as unknown as ApiEnv;

describe('FileStorageModule — one binding, one exported token', () => {
  /**
   * `compile()` and not `init()`: the point here is the *shape of the graph*,
   * not the adapter's start-up check. The environment is overridden for the
   * same reason — this test says nothing about a directory, so it must not
   * depend on one existing.
   */
  const build = async () =>
    Test.createTestingModule({ imports: [FileStorageModule] })
      .overrideProvider(API_ENV)
      .useValue(TEST_ENV)
      .compile();

  it('hands out the seam', async () => {
    const moduleRef = await build();
    expect(moduleRef.get(FileStorage)).toBeInstanceOf(FileStorage);
  });

  /**
   * The load-bearing half. A consumer that can reach the concrete adapter can
   * reach a filesystem, and „kein Code außerhalb dieser Naht weiß, wo eine
   * Datei liegt"  would then be a statement about who imports
   * what rather than about what is reachable.
   *
   * `{ strict: false }` searches the **whole** graph, including everything the
   * module imported — which is precisely the direction the earlier failure came from.
   */
  it('does not hand out the adapter, not even from the whole graph', async () => {
    const moduleRef = await build();
    expect(() => moduleRef.get(LocalFileStorage, { strict: false })).toThrow();
  });

  it('exports exactly one token', () => {
    expect(exportsOf(FileStorageModule)).toStrictEqual([FileStorage]);
  });

  /**
   * **The wiring half of ADR-0014 no. 2, and the half a comment cannot
   * promise.** „Fehlt das Verzeichnis, startet die Anwendung nicht" only holds
   * if the adapter's `onModuleInit` actually runs — and the adapter is built by
   * a **factory**, not by `useClass`. Whether Nest calls lifecycle hooks on a
   * factory-produced instance is a property of the framework, so it is measured
   * here rather than assumed; `init()` is the call `main.ts` reaches through
   * `listen()`.
   *
   * *Reproduction:* dropping `implements OnModuleInit` (or the `verifyRoot()`
   * call inside it) turns this red while every other test stays green — which
   * is exactly the shape of a silent regression: the API would come up and the
   * first upload would answer 500.
   */
  it('refuses to start when the configured directory is not there', async () => {
    const moduleRef = await build();
    // No `close()` afterwards on purpose: an application whose init failed has
    // nothing to tear down, and Nest surfaces the same failure a second time
    // from `close()` — measured, and it would read as a second, unrelated
    // error in this test's output.
    await expect(moduleRef.init()).rejects.toThrow(/FILE_STORAGE_DIR/);
  });
});

describe('MailClockModule — the module that established the shape (retrofitted)', () => {
  it('hands out the clock and nothing else', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MailClockModule],
    }).compile();

    expect(moduleRef.get(MailClock)).toBeInstanceOf(MailClock);
    // The concrete class is bound *to* the abstract token, so asking for it by
    // name must fail — otherwise „ein Binding" would be two names for one
    // instance, and the next provider added here would inherit the excuse.
    expect(() => moduleRef.get(SystemMailClock, { strict: false })).toThrow();
  });

  it('exports exactly one token', () => {
    expect(exportsOf(MailClockModule)).toStrictEqual([MailClock]);
  });
});
