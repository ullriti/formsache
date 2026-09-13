import {
  parsePublishPreview,
  questionPlaceholderToken,
  unresolvableConditionText,
  type PublishBlocked,
  type PublishBlockedCondition,
} from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import {
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, openSession } from '../support/http';

/**
 * The requirement — **a condition that points nowhere blocks
 * publishing**.
 *
 * Written to the shape of the placeholder lock
 * (`test/notifications/publish-lock.spec.ts`), because it *is* that lock one
 * requirement further along: refused with a 422, refused **before** a
 * `form_version` row is written — counted before and after — and the refusal
 * names the question the editor has to open. A test that read the status code
 * alone would not notice a refusal that had already minted a version, and the
 * next attempt would find the lock still in place with the damage done.
 *
 * **The three proofs of the requirement have one case each**: source removed,
 * source retyped, source dragged behind the question depending on it. The
 * second is the one this requirement warns about — a retyped question mints a new
 * id and `publishDiff()` pairs the two into one line, so the
 * predecessor appears nowhere in the diff. `condition.test.ts` measures that
 * pairing directly; here it is the case that a lock built on `removed` would
 * publish.
 *
 * **Two negative probes, both measured while writing this file** (the numbers
 * are the ones this file produced, not an expectation):
 *
 * 1. The lock hung on `publishDiff(…).removed` — the requirement's own
 *    reproduction — leaves it **2 red of 6**: the retype case *and* the moved
 *    source publish with a 200, since neither id is ever reported as removed.
 *    The removal case stays green, and so do all three controls, which is what
 *    makes them controls.
 * 2. The whole block taken out of `FormsService.publish()`: **3 red of 6** —
 *    exactly the three refusals, the three controls untouched.
 *
 * The third proof is the one that looks like a sorting question and is not:
 * it is the rule „Quelle ist eine **vorherige** Frage", asked at publish time, and
 * it is answered by the same function the fill-in view resolves conditions with
 * (`resolveConditionSource` in `packages/shared/src/condition.ts`).
 *
 * ## Addendum — the same lock, one moment earlier
 *
 * The second `describe` below measures `publishPreview()`: the same finding
 * stands there, so that an editor reads it **in the preview dialog** instead
 * of as a 422 on the click. It belongs in **this** place, because the finding
 * arises here — the web tests feed the dialog a payload of their own and
 * prove nothing at all by way of the server (which is exactly why
 * `blocked: []` once went on looking right unnoticed for a long time).
 *
 * **Two reproductions, both run** (the numbers are measured, not
 * expected):
 *
 * 1. Letting the preview narrow the findings down to `publishDiff(…).removed`
 *    instead of asking the draft: **2 red of 10** — „carries the type change"
 *    and „carries the source that moved". The removal case stays green, and
 *    that is exactly why the type change stands there as a case of its
 *    **own**: a preview that fails to find only it looks intact in every other
 *    case.
 * 2. Returning `blocked: []` from `publishPreview()`: **3 red of 10** here,
 *    plus the placeholder case in `test/notifications/publish-lock.spec.ts`
 *    (4 of 17 together). **The whole web suite stayed green throughout** — 85
 *    cases in `BuilderView.test.tsx`, all with a hand-written payload —, and
 *    the whole shared suite too. That is the same experience, measured once
 *    more: the preview half is provable **only** here.
 *
 * Both numbers come from the state with **ten** cases. The review has added
 * two more — „Quelle in beiden Dokumenten weg"
 * (`sourceLabel: null`) and „beide Gestalten auf einmal" —, which go red
 * under both reproductions as well; the reproductions were **not run again**
 * for them, so the denominators above are the ones from back then.
 */

const PASSWORD = 'test-password';

const PAGE = '019ff800-0000-7000-8000-0000000000a0';
const SOURCE = '019ff800-0000-7000-8000-000000000001';
const DEPENDENT = '019ff800-0000-7000-8000-000000000002';
/** The successor of a retyped source — it receives a new id. */
const RETYPED = '019ff800-0000-7000-8000-000000000003';

const questionBase = { hint: null, required: false, width: 'full' as const };

/** The source: an Auswahlfrage, „Anreise". */
const anreise = {
  ...questionBase,
  id: SOURCE,
  type: 'select',
  label: 'Anreise',
  options: [
    { value: 'bahn', label: 'Bahn' },
    { value: 'auto', label: 'Auto' },
  ],
  allowOther: false,
  otherLabel: null,
};

/** Same question, same id, different caption — renaming has to stay free. */
const renamedAnreise = { ...anreise, label: 'Wie reisen Sie an?' };

/**
 * „Anreise" after a type change: **new id**, same caption, `replaces` pointing
 * back — exactly what the builder writes.
 */
const retypedAnreise = {
  ...questionBase,
  id: RETYPED,
  type: 'text',
  label: 'Anreise',
  minLength: null,
  maxLength: null,
  pattern: null,
  replaces: SOURCE,
};

/** The dependant, shown only for „Bahn". */
const mitfahren = {
  ...questionBase,
  id: DEPENDENT,
  type: 'text',
  label: 'Mitfahrgelegenheit',
  minLength: null,
  maxLength: null,
  pattern: null,
  visibleIf: { questionId: SOURCE, operator: 'equals', value: 'bahn' },
};

/** The same question without any condition — the repair the message asks for. */
const unconditionalMitfahren = { ...mitfahren, visibleIf: undefined };

function withQuestions(questions: readonly unknown[]): unknown {
  return { pages: [{ id: PAGE, title: 'Seite 1', questions }] };
}

/**
 * The one finding of a case that has one — and a failure with a sentence when
 * it does not.
 *
 * `conditions[0]!` would read the same and say nothing when the list is empty,
 * which is exactly the state a broken preview leaves behind.
 */
function onlyCondition(
  conditions: readonly PublishBlockedCondition[],
): PublishBlockedCondition {
  const [finding, ...rest] = conditions;
  if (finding === undefined || rest.length > 0) {
    throw new Error(
      `Dieser Fall erzeugt genau einen Bedingungs-Befund, nicht ${String(conditions.length)}.`,
    );
  }
  return finding;
}

describe('publish lock on conditions pointing nowhere', () => {
  let testApp: TestApp;
  let alpha: TenantFixture;
  let admin: string;
  let database: TestDatabase | undefined;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'D3CT');
    const user = await createUser(testApp.prisma, {
      email: 'condition-lock@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    admin = await openSession(testApp, user.id, alpha.id);
  }, 180_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  async function createForm(
    title: string,
  ): Promise<{ id: string; revision: number }> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(admin))
      .send({ title });
    expect(created.status).toBe(201);
    return created.body as { id: string; revision: number };
  }

  async function saveDraft(
    formId: string,
    revision: number,
    questions: readonly unknown[],
    title: string,
  ): Promise<number> {
    const saved = await request(app().server)
      .put(apiPath(`/forms/${formId}`))
      .set(authedMutation(admin))
      .send({ title, definition: withQuestions(questions), revision });
    expect(saved.status).toBe(200);
    return (saved.body as { revision: number }).revision;
  }

  function publish(formId: string, revision: number): request.Test {
    return request(app().server)
      .post(apiPath(`/forms/${formId}/publish`))
      .set(authedMutation(admin))
      .send({ revision });
  }

  /**
   * The verdict the publish dialog reads — parsed through the **wire schema**
   * (the requirement).
   *
   * `parsePublishPreview` rather than a cast: what the dialog gets is what
   * `publishPreviewSchema` lets through, so a finding the server spells
   * differently from the contract fails here instead of turning into a silently
   * missing list item in the browser.
   */
  async function preview(formId: string): Promise<{
    readonly removed: readonly string[];
    readonly blocked: readonly PublishBlocked[];
    readonly conditions: readonly PublishBlockedCondition[];
    readonly kinds: readonly string[];
    readonly blockedCount: number;
  }> {
    const response = await request(app().server)
      .get(apiPath(`/forms/${formId}/publish-preview`))
      .set(authedMutation(admin));
    expect(response.status).toBe(200);

    const body = parsePublishPreview(response.body);
    return {
      removed: body.changes.removed.map((question) => question.id),
      blocked: body.blocked,
      conditions: body.blocked.filter(
        (finding): finding is PublishBlockedCondition =>
          finding.kind === 'condition',
      ),
      /** In the order they arrive — see „Both shapes at once" below. */
      kinds: body.blocked.map((finding) => finding.kind),
      blockedCount: body.blocked.length,
    };
  }

  /**
   * A notification on this form. Only this suite's one case needs one, and it
   * needs it for the half the condition lock cannot produce on its own.
   */
  async function addNotification(formId: string, body: object): Promise<void> {
    const created = await request(app().server)
      .post(apiPath(`/forms/${formId}/notifications`))
      .set(authedMutation(admin))
      // Required and nullable without a default; this suite has
      // nothing to say about it.
      .send({ replyTo: null, ...body });
    expect(created.status).toBe(201);
  }

  function versionCount(formId: string): Promise<number> {
    return app().prisma.formVersion.count({ where: { formId } });
  }

  /**
   * A published form with source and dependant in the right order — the
   * starting point of every case below.
   *
   * That first publish is itself part of the proof: the intact form goes
   * through, so every refusal further down is about what the *next* draft did
   * and not about conditions being refused as such.
   */
  async function publishedForm(
    title: string,
  ): Promise<{ formId: string; revision: number }> {
    const form = await createForm(title);
    const saved = await saveDraft(
      form.id,
      form.revision,
      [anreise, mitfahren],
      title,
    );
    const published = await publish(form.id, saved);
    expect(published.status).toBe(200);
    return {
      formId: form.id,
      revision: (published.body as { revision: number }).revision,
    };
  }

  it('refuses the publish when the source question is removed', async () => {
    const { formId, revision } = await publishedForm('Quelle entfernt');

    const next = await saveDraft(
      formId,
      revision,
      [mitfahren],
      'Quelle entfernt',
    );
    const before = await versionCount(formId);

    const response = await publish(formId, next);

    expect(response.status).toBe(422);
    const message = (response.body as { message: string }).message;
    // **Names the question**, which is the content of the requirement: „irgendwo
    // stimmt was nicht" leaves the editor opening every question in the form.
    expect(message).toContain('Mitfahrgelegenheit');
    // …and the source, by the caption the version in force still knows.
    expect(message).toContain('Anreise');

    // The load-bearing half: no version was minted, and the revision did not
    // move either — a refusal that bumped it would log the editor out of their
    // next save.
    expect(await versionCount(formId)).toBe(before);
    const form = await app().prisma.form.findUniqueOrThrow({
      where: { id: formId },
    });
    expect(form.revision).toBe(next);
  });

  /**
   * **The case a lock built on `publishDiff().removed` would publish.**
   *
   * The draft carries the successor with its new id and `replaces`, exactly as
   * the builder writes it; the diff therefore reports one type change and no
   * removal at all, while the condition still names the id that is gone.
   */
  it('refuses it when the source changes type', async () => {
    const { formId, revision } = await publishedForm('Typwechsel');

    const next = await saveDraft(
      formId,
      revision,
      [retypedAnreise, mitfahren],
      'Typwechsel',
    );
    const before = await versionCount(formId);

    const response = await publish(formId, next);

    expect(response.status).toBe(422);
    const message = (response.body as { message: string }).message;
    expect(message).toContain('Mitfahrgelegenheit');
    // The half sentence about the type change is what makes the refusal
    // readable here: „Anreise" is still on the canvas, under that very caption.
    expect(message).toContain('Typwechsel');
    expect(await versionCount(formId)).toBe(before);
  });

  it('refuses it when the source is moved behind its dependant', async () => {
    const { formId, revision } = await publishedForm('Verschoben');

    // Same two questions, same ids, only the order swapped — nothing is
    // removed and nothing is retyped.
    const next = await saveDraft(
      formId,
      revision,
      [mitfahren, anreise],
      'Verschoben',
    );
    const before = await versionCount(formId);

    const response = await publish(formId, next);

    expect(response.status).toBe(422);
    const message = (response.body as { message: string }).message;
    expect(message).toContain('Mitfahrgelegenheit');
    expect(message).toContain('steht erst nach dieser Frage');
    expect(await versionCount(formId)).toBe(before);
  });

  /**
   * The **control** of the negative probe, and written so that it stays green
   * when the lock is removed: it asserts only that the repaired draft goes
   * through. A case that checked the refusal first would go red together with
   * the ones above and prove nothing about where the lock stops.
   */
  it('publishes once the condition is taken out', async () => {
    const { formId, revision } = await publishedForm('Reparatur');

    const next = await saveDraft(
      formId,
      revision,
      [unconditionalMitfahren],
      'Reparatur',
    );
    const before = await versionCount(formId);

    const response = await publish(formId, next);

    expect(response.status).toBe(200);
    expect(await versionCount(formId)).toBe(before + 1);
  });

  it('leaves the condition alone when the source is merely renamed', async () => {
    const { formId, revision } = await publishedForm('Umbenennen');

    const next = await saveDraft(
      formId,
      revision,
      [renamedAnreise, mitfahren],
      'Umbenennen',
    );
    const before = await versionCount(formId);

    const response = await publish(formId, next);

    // The id binds, not the caption — otherwise every rewording in the builder
    // would be a publishing ban.
    expect(response.status).toBe(200);
    expect(await versionCount(formId)).toBe(before + 1);
  });

  /**
   * **The requirement — the refusal is readable *before* the button.**
   *
   * The same lock, one moment earlier: `publishPreview()` carries the finding of
   * `findUnresolvableConditions()` — the very function `publish()` refuses with
   * — so the editor reads it in the dialog instead of meeting it as a 422.
   *
   * **Checked here, not in a file of its own**, exactly as the placeholder half
   * is (`test/notifications/publish-lock.spec.ts`): it is the same lock, the
   * same fixtures and the same three cases, and a second suite would be a second
   * set of forms to keep in step.
   *
   * ⚠️ **The server is where this belongs.** The same promise was once made for
   * placeholders and left untested on this side; setting `blocked: []` in the
   * service left the whole web suite *and* the whole shared suite green, because
   * the web tests feed the dialog a payload of their own and never ask the
   * server for one. A promise proven only against a hand-written fixture is a
   * promise about the fixture.
   */
  describe('the preview carries the same finding', () => {
    /**
     * **the evidence** — and the two halves that make it one: the entry names the
     * affected question, and it says it in the **same words** as the 422.
     *
     * The wording is compared, not eyeballed: the sentence the dialog will
     * render (`unresolvableConditionText` over the entry that actually arrived)
     * has to occur verbatim in the refusal of the very same draft. A preview
     * that dropped `sourceLabel` or `defect` would still name the question and
     * would fail here, which is the point — those two are what turn „irgendwo
     * stimmt was nicht" into something to repair.
     */
    it('names the affected question, in the words of the refusal', async () => {
      const { formId, revision } = await publishedForm('Vorschau Quelle');

      // The control: nothing blocks while the draft is intact, so the assertion
      // below is not „blocked is always non-empty".
      expect((await preview(formId)).blockedCount).toBe(0);

      const next = await saveDraft(
        formId,
        revision,
        [mitfahren],
        'Vorschau Quelle',
      );
      const before = await versionCount(formId);

      const { conditions } = await preview(formId);
      expect(conditions).toEqual([
        {
          kind: 'condition',
          questionLabel: 'Mitfahrgelegenheit',
          sourceLabel: 'Anreise',
          defect: 'missing',
        },
      ]);

      const finding = onlyCondition(conditions);

      // **The same text.** Not „both mention the question" — the sentence the
      // dialog builds from this entry is a substring of the refusal the button
      // would produce, so the two cannot drift apart while both stay green.
      const refused = await publish(formId, next);
      expect(refused.status).toBe(422);
      expect((refused.body as { message: string }).message).toContain(
        unresolvableConditionText(finding),
      );

      // A preview is a read, and the refusal is one too: nothing was minted.
      expect(await versionCount(formId)).toBe(before);
    });

    /**
     * **the evidence — the case the requirement is written against.**
     *
     * The draft carries the successor with its new id and `replaces`, exactly as
     * the builder writes it. `changes.removed` is asserted **empty
     * in the same breath**: that is the measurement, not a remark. A preview
     * that asked `publishDiff().removed` instead of the draft would return an
     * empty `blocked` here, offer the confirm button, and the editor would meet
     * the 422 the dialog was supposed to spare them.
     */
    it('carries the type change the diff pairs into one line', async () => {
      const { formId, revision } = await publishedForm('Vorschau Typwechsel');

      await saveDraft(
        formId,
        revision,
        [retypedAnreise, mitfahren],
        'Vorschau Typwechsel',
      );

      const { conditions, removed } = await preview(formId);

      expect(removed).toEqual([]);
      expect(conditions).toEqual([
        {
          kind: 'condition',
          questionLabel: 'Mitfahrgelegenheit',
          // The caption comes from the version in force — „Anreise" is still on
          // the canvas under that very name, which is why the sentence has to
          // say the type change out loud.
          sourceLabel: 'Anreise',
          defect: 'missing',
        },
      ]);
      expect(unresolvableConditionText(onlyCondition(conditions))).toContain(
        'Typwechsel',
      );
    });

    /** The third shape of „zeigt ins Leere", with its own sentence. */
    it('carries the source that moved behind its dependant', async () => {
      const { formId, revision } = await publishedForm('Vorschau Verschoben');

      await saveDraft(
        formId,
        revision,
        [mitfahren, anreise],
        'Vorschau Verschoben',
      );

      const { conditions, removed } = await preview(formId);

      expect(removed).toEqual([]);
      expect(conditions).toEqual([
        {
          kind: 'condition',
          questionLabel: 'Mitfahrgelegenheit',
          sourceLabel: 'Anreise',
          defect: 'later',
        },
      ]);
      expect(unresolvableConditionText(onlyCondition(conditions))).toContain(
        'steht erst nach dieser Frage',
      );
    });

    /**
     * **The source is gone from both documents** — then it has no caption, and
     * the sentence has to work without one.
     *
     * Reached the only way it can be: the version in force is republished
     * *without* the source and without any condition, and only then does the
     * condition come back into the draft. That is not a contrived state — it is
     * an editor who tidied up, published, and later pasted an old page back in.
     * `sourceLabel: null` is the shape the wire schema explicitly allows
     * (`forms.test.ts`), and this is where it is produced rather than asserted
     * about a hand-written fixture.
     */
    it('reports a source gone from both documents without a caption', async () => {
      const title = 'Vorschau Quelle unbekannt';
      const { formId, revision } = await publishedForm(title);

      // The version in force loses the source: dependant alone, unconditional.
      const second = await saveDraft(
        formId,
        revision,
        [unconditionalMitfahren],
        title,
      );
      const published = await publish(formId, second);
      expect(published.status).toBe(200);

      // …and now the condition comes back, naming an id that neither the draft
      // nor the version in force has any longer.
      await saveDraft(
        formId,
        (published.body as { revision: number }).revision,
        [mitfahren],
        title,
      );

      const { conditions } = await preview(formId);
      expect(conditions).toEqual([
        {
          kind: 'condition',
          questionLabel: 'Mitfahrgelegenheit',
          sourceLabel: null,
          defect: 'missing',
        },
      ]);
      // The question is still named — that is the requirement — and the source
      // stands as „Die Quellfrage" rather than as „„null"" or an empty gap.
      const sentence = unresolvableConditionText(onlyCondition(conditions));
      expect(sentence).toContain('Mitfahrgelegenheit');
      expect(sentence).toContain('Die Quellfrage fehlt in der neuen Fassung');
      expect(sentence).not.toContain('null');
    });

    /**
     * **Both shapes at once** — the case one field for two shapes exists
     * for, and the one thing the dialog's own tests cannot show: they hand
     * themselves a payload carrying both, which proves nothing about whether the
     * server ever produces one.
     *
     * One removal produces both halves here: the notification's body names the
     * source question, and the dependant's condition names it too. That is not
     * an arrangement for the test's sake — it is the ordinary case, because the
     * question worth pointing a placeholder at is the question worth branching
     * on.
     *
     * **And it measures the order** the publish dialog states as a promise
     * („die Bedingungen zuerst, in der Reihenfolge, in der Server
     * ablehnt"): `publish()` asks the draft's conditions before it reads this
     * organisation's notifications, so `blocked` has to arrive that way round. Swap the
     * two spreads in `publishPreview()` and this goes red; without this case the
     * promise was a remark about code somebody had read.
     */
    it('carries both shapes of one removal, the conditions first', async () => {
      const title = 'Vorschau Beides';
      const { formId, revision } = await publishedForm(title);

      await addNotification(formId, {
        name: 'Bestätigung',
        subject: 'Anmeldung eingegangen',
        body: `Sie reisen mit ${questionPlaceholderToken(SOURCE)} an.`,
      });

      // The control: the notification is intact while the source is there, so
      // the two findings below come from the removal and not from the fixture.
      expect((await preview(formId)).blockedCount).toBe(0);

      await saveDraft(formId, revision, [mitfahren], title);

      const { blocked, kinds } = await preview(formId);

      expect(kinds).toEqual(['condition', 'placeholder']);
      expect(blocked).toEqual([
        {
          kind: 'condition',
          questionLabel: 'Mitfahrgelegenheit',
          sourceLabel: 'Anreise',
          defect: 'missing',
        },
        {
          kind: 'placeholder',
          notificationName: 'Bestätigung',
          token: questionPlaceholderToken(SOURCE),
          label: 'Anreise',
          places: ['body'],
        },
      ]);
    });

    /**
     * The **control** of the negative probes: a repaired draft blocks nothing.
     * Written so that it stays green when the finding is dropped from the
     * preview — a case that asserted the block first would go red together with
     * the three above and prove nothing about where the block stops.
     */
    it('blocks nothing once the condition is taken out', async () => {
      const { formId, revision } = await publishedForm('Vorschau Reparatur');

      await saveDraft(
        formId,
        revision,
        [unconditionalMitfahren],
        'Vorschau Reparatur',
      );

      expect((await preview(formId)).blockedCount).toBe(0);
    });
  });

  it('lets a question nothing depends on disappear', async () => {
    const { formId, revision } = await publishedForm('Fremde Frage');

    // The **dependent** question goes; the source stays and nothing points at
    // it any more. A lock that fired here would be a lock on publishing.
    const next = await saveDraft(formId, revision, [anreise], 'Fremde Frage');
    const before = await versionCount(formId);

    const response = await publish(formId, next);

    expect(response.status).toBe(200);
    expect(await versionCount(formId)).toBe(before + 1);
  });
});
