import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FormDeadline } from './FormDeadline';

/**
 * Finding 32 — the deadline above the form, and the clock that sees it expire.
 *
 * The wording lives in `deadline-notice.test.ts`. What is checked here is
 * the only thing this component contributes to it: that the line flips
 * **while** the form is being filled in, without anyone reloading the page.
 */
/** What `setTimeout` just barely accepts as a delay — see `FormDeadline`. */
const MAX_TIMEOUT_MS = 2_147_483_647;

describe('FormDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders nothing for a form with neither a deadline nor a time limit', () => {
    const { container } = render(
      <FormDeadline closesAt={null} timeLimitMin={null} />,
    );

    expect(container.firstChild).toBeNull();
  });

  /**
   * **A form with a mere time limit has a line as well** (finding 32). Without
   * a deadline there was nothing to render here before, and the number of
   * minutes would not have reached that same page at all — exactly the state in
   * which someone types thirty fields and then runs into the 409.
   */
  it('renders the time limit for a form without any deadline', () => {
    render(<FormDeadline closesAt={null} timeLimitMin={30} />);

    expect(screen.getByTestId('public-deadline').textContent).toBe(
      'Für das Ausfüllen stehen ab dem Öffnen dieser Seite 30 Minuten zur Verfügung.',
    );
  });

  /**
   * **The case this is about.** The page is opened while the form
   * is open, and stays up beyond the deadline — the tab that stays open over
   * lunch. There was no statement about that before: the participant learned
   * of it at the 409 of their submission, after thirty typed fields.
   */
  it('turns into the expired notice when the deadline passes while the page is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const closesAt = new Date(Date.now() + 60_000).toISOString();

    // With a time limit, so that the same line carries both bounds — and the
    // switch shows that the number of minutes disappears afterwards: what a
    // form would have granted as filling-in time is no information any more
    // once it accepts nothing.
    render(<FormDeadline closesAt={closesAt} timeLimitMin={30} />);

    expect(screen.getByTestId('public-deadline').textContent).toContain(
      'kann noch bis',
    );
    expect(screen.getByTestId('public-deadline').textContent).toContain(
      '30 Minuten',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    const line = screen.getByTestId('public-deadline');
    expect(line.textContent).toContain('Die Frist ist am');
    expect(line.textContent).toContain('bleiben erhalten');
    expect(line.textContent).not.toContain('30 Minuten');
    expect(line.className).toContain('public__deadline--expired');
  });

  /**
   * **A deadline two months away must not send a timer into a
   * loop.** `setTimeout` computes the delay in a signed
   * 32-bit value; anything over ~24,8 days overflows and fires
   * *immediately*. Without the capping in `FormDeadline` the effect would run
   * endlessly, and invisibly at that — the line would look right.
   *
   * ⚠️ **Measured at the interface, not at the behaviour**
   * (review follow-up). The overflow is a peculiarity of the *real*
   * `setTimeout`; Vitest's timers do not trim the delay to 32 bits,
   * so under them there is nothing at all to overflow — a test that
   * checks the standing line after a day would stay green if the capping were
   * removed. So the number the component passes is what gets checked.
   */
  it('kappt die Verzögerung auf das, was `setTimeout` noch annimmt', () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const closesAt = new Date(Date.now() + 60 * 24 * 3_600_000).toISOString();

    render(<FormDeadline closesAt={closesAt} timeLimitMin={null} />);

    const delays = setTimeoutSpy.mock.calls.map(([, delay]) => delay ?? 0);
    expect(delays).toContain(MAX_TIMEOUT_MS);
    // Not a single one above it — without the capping the deadline two months
    // away would be ~5,2 billion milliseconds and would therefore fire at once,
    // again and again.
    expect(delays.every((delay) => delay <= MAX_TIMEOUT_MS)).toBe(true);
  });

  /** The running line still stands after a day, too — the same deadline. */
  it('keeps a deadline months away on the running notice', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const closesAt = new Date(Date.now() + 60 * 24 * 3_600_000).toISOString();

    render(<FormDeadline closesAt={closesAt} timeLimitMin={null} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    });

    expect(screen.getByTestId('public-deadline').textContent).toContain(
      'kann noch bis',
    );
  });

  /**
   * A timer that still sets state after the component has been torn down is
   * a warning in the console and a leak — the same assurance
   * `RedirectCountdown` gives for its countdown.
   *
   * ⚠️ **Measured at the `clearTimeout`, not at the empty page**
   * (review follow-up). After `unmount()` the line is gone anyway, with
   * cleanup as without — the claim `queryByTestId(…) === null` is true
   * no matter what the component does. What it *does* is exactly one thing: it
   * gives back the handle it fetched for itself.
   */
  it('stops its timer when it is unmounted before the deadline', () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const closesAt = new Date(Date.now() + 30_000).toISOString();

    const { unmount } = render(
      <FormDeadline closesAt={closesAt} timeLimitMin={null} />,
    );

    // The handle of *this* component: the only delay that is exactly the
    // remaining time until the deadline (Testing Library sets up its own
    // timers).
    const armed = setTimeoutSpy.mock.calls.findIndex(
      ([, delay]) => delay === 30_000,
    );
    expect(armed).toBeGreaterThanOrEqual(0);
    const handle = setTimeoutSpy.mock.results[armed]?.value as unknown;
    expect(handle).toBeDefined();

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(handle);
  });
});
