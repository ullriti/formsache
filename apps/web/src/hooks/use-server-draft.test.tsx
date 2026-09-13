import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { renderWithQuery } from '../test/render-with-query';
import { useServerDraft } from './use-server-draft';

/**
 * The shared shape behind the requirement, tested on its own.
 *
 * The three view tests exercise it through a `fetch` stub, a query cache and a
 * settings form — which is the right place to prove that *the page* keeps an
 * entry, and the wrong place to reach its branches. Two of them are invisible
 * from there: a key that changes **while a save is in flight**, and a draft that
 * must not come back when its subject is opened again. The second one was a data
 * loss (a stale draft laid over a reloaded document with a newer revision), and
 * this file is where it should have been caught.
 *
 * The harness stands in for a view: `subject` is what the shell switches, and
 * `baseline` is what the server last sent.
 */

interface Draft {
  readonly text: string;
}

function Harness({
  initialSubject = 'a',
  baselineOf = (subject: string) => ({ text: `server:${subject}` }),
}: {
  readonly initialSubject?: string;
  readonly baselineOf?: (subject: string) => Draft;
}): ReactElement {
  const [subject, setSubject] = useState(initialSubject);
  /** Held outside the hook, like a mutation's `onSuccess` callback is. */
  const [adopt, setAdopt] = useState<(() => void) | null>(null);
  const { draft, setDraft, beginSave } = useServerDraft<Draft>(
    subject,
    baselineOf(subject),
  );

  return (
    <div>
      <span data-testid="subject">{subject}</span>
      <span data-testid="draft">{draft === null ? '—' : draft.text}</span>
      <input
        aria-label="Feld"
        value={draft?.text ?? ''}
        onChange={(event) => {
          setDraft({ text: event.target.value });
        }}
      />
      <button
        type="button"
        onClick={() => {
          setSubject((previous) => (previous === 'a' ? 'b' : 'a'));
        }}
      >
        Wechseln
      </button>
      {/* The two halves of a save, separately, so a test can put anything
          between them — which is the whole point of this file. */}
      <button
        type="button"
        onClick={() => {
          setAdopt(() => beginSave());
        }}
      >
        Speichern
      </button>
      <button
        type="button"
        onClick={() => {
          adopt?.();
        }}
      >
        Antwort
      </button>
    </div>
  );
}

function field(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('Feld');
}

function shownDraft(): string {
  return screen.getByTestId('draft').textContent;
}

function click(name: string): void {
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('useServerDraft', () => {
  it('shows the baseline until something is typed', () => {
    renderWithQuery(<Harness />);

    expect(shownDraft()).toBe('server:a');
  });

  it('shows the local draft once something is typed', () => {
    renderWithQuery(<Harness />);

    fireEvent.change(field(), { target: { value: 'getippt' } });

    expect(shownDraft()).toBe('getippt');
  });

  /** The reason `onSuccess` exists: the answer *is* the new baseline. */
  it('adopts the answer when nothing was typed while it was in flight', () => {
    renderWithQuery(<Harness />);

    fireEvent.change(field(), { target: { value: 'getippt' } });
    click('Speichern');
    click('Antwort');

    expect(shownDraft()).toBe('server:a');
  });

  /**
   * The race itself. Counted, not compared — which the next case is about.
   */
  it('keeps what was typed while the answer was on its way', () => {
    renderWithQuery(<Harness />);

    fireEvent.change(field(), { target: { value: 'erst' } });
    click('Speichern');
    fireEvent.change(field(), { target: { value: 'dann' } });
    click('Antwort');

    expect(shownDraft()).toBe('dann');
  });

  /**
   * **Counting, not comparing.** Typing a field back to the value it already
   * held is still typing, and the editor is still looking at a cursor in it. A
   * hook that compared values would adopt here and take the cursor's content
   * away for no visible reason.
   */
  it('keeps an entry that happens to equal what was sent', () => {
    renderWithQuery(<Harness />);

    fireEvent.change(field(), { target: { value: 'gleich' } });
    click('Speichern');
    // Away and back again: two edits, and the value ends up as the one that was
    // sent. Typed *once* with the same value there would be no edit at all —
    // React fires no `change` for an unchanged value, which is why the detour
    // is here rather than a second identical `fireEvent`.
    fireEvent.change(field(), { target: { value: 'anders' } });
    fireEvent.change(field(), { target: { value: 'gleich' } });
    click('Antwort');

    // Still the local draft, not the baseline the answer would have restored.
    expect(shownDraft()).toBe('gleich');
  });

  /**
   * The branch `previous.key === savedKey`: the subject changed **while the save
   * was in flight**, so the answer belongs to a document nobody is looking at.
   * It must not reach into the draft of the subject that is on screen now.
   */
  it('does not let a late answer touch the draft of another subject', () => {
    renderWithQuery(<Harness />);

    fireEvent.change(field(), { target: { value: 'für a' } });
    click('Speichern');
    click('Wechseln');
    fireEvent.change(field(), { target: { value: 'für b' } });
    click('Antwort');

    expect(screen.getByTestId('subject').textContent).toBe('b');
    expect(shownDraft()).toBe('für b');
  });

  it('drops a draft when its subject is left', () => {
    renderWithQuery(<Harness />);

    fireEvent.change(field(), { target: { value: 'für a' } });
    click('Wechseln');

    expect(shownDraft()).toBe('server:b');
  });

  /**
   * …and it stays dropped. Reading the slot through the tag hides a stale draft
   * while another subject is shown but leaves it lying there; coming back
   * resurrected entries typed against a document that has since been reloaded,
   * revision included. A review caught exactly this.
   */
  it('does not resurrect a draft when its subject is opened again', () => {
    renderWithQuery(<Harness />);

    fireEvent.change(field(), { target: { value: 'für a' } });
    click('Wechseln');
    click('Wechseln');

    expect(screen.getByTestId('subject').textContent).toBe('a');
    expect(shownDraft()).toBe('server:a');
  });

  /** No document yet: nothing to show, and nothing that could be saved. */
  it('has no draft before the first document arrives', () => {
    function Loading(): ReactElement {
      const { draft } = useServerDraft<Draft>('a', undefined);
      return (
        <span data-testid="draft">{draft === null ? '—' : draft.text}</span>
      );
    }
    renderWithQuery(<Loading />);

    expect(shownDraft()).toBe('—');
  });
});
