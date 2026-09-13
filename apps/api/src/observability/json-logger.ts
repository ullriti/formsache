import { ConsoleLogger, type LogLevel } from '@nestjs/common';

/**
 * **Machine-readable log lines for production** (* ADR-0016).
 *
 * The application used to write with Nest's default logger: colourful,
 * multi-line lines for a terminal. For an installation that nobody
 * watches, that is the wrong shape — an operator who wants to make sense of a
 * complaint needs `grep`-able JSON and a **request id** that they find again in
 * the response.
 *
 * ## What is not here, and why
 *
 * ⚠️ **This class filters nothing.** It formats. The protection against
 * personal data in the log lies with the **call site** — every
 * log line of this application names codes, classes and numbers, never values.
 * A filter here would be the worse defence: it would have to guess what is
 * free text, and it would let through the one line whose pattern it does not know.
 *
 * The reason for that has become real twice: `MISTRAL_DEBUG` printed the
 * API key in plaintext, `ANTHROPIC_LOG=debug` the free text of the
 * editor. A review found both, no test — which is why
 * `test/observability/log-hygiene.spec.ts` now holds one.
 */
export class JsonLogger extends ConsoleLogger {
  /**
   * The request within whose scope logging is currently happening.
   *
   * A module-wide state instead of an injected context, because Nest's logger
   * is built **before** injection and every line hits it —
   * including the one from a background run, which then simply carries no id.
   */
  private static currentRequestId: string | undefined;

  static runWithRequestId<T>(requestId: string, work: () => T): T {
    const previous = JsonLogger.currentRequestId;
    JsonLogger.currentRequestId = requestId;
    try {
      return work();
    } finally {
      JsonLogger.currentRequestId = previous;
    }
  }

  /**
   * **Raw stacks stay out** (a review finding).
   *
   * `ConsoleLogger.error(message, stack)` additionally calls
   * `printStackTrace(stack)` after the message, and the default writes the
   * stack **unformatted to stderr** — past this class, multi-line, without a
   * request id, and with everything that a third-party library has written into
   * its message. An application that logs codes and classes
   * everywhere else was thereby handing out free text at exactly one place.
   *
   * The stack is therefore **not discarded, but enqueued**: as a
   * JSON line like any other, with `level: 'error'` and the same
   * request id. Discarding would be the worse choice — in an incident the stack
   * is the only thing that names the place.
   */
  protected override printStackTrace(stack: string): void {
    if (stack === '') {
      return;
    }
    this.printMessages([stack], 'stack', 'error');
  }

  protected override printMessages(
    messages: unknown[],
    context = '',
    logLevel: LogLevel = 'log',
  ): void {
    for (const message of messages) {
      process.stdout.write(
        `${JSON.stringify({
          time: new Date().toISOString(),
          level: logLevel,
          context: context || undefined,
          requestId: JsonLogger.currentRequestId,
          message: typeof message === 'string' ? message : safeText(message),
        })}\n`,
      );
    }
  }
}

/**
 * A non-string argument as text.
 *
 * `JSON.stringify` and not `String(…)`: `String({})` yields
 * `[object Object]`, which produces a line that looks like a log and
 * says nothing.
 */
function safeText(value: unknown): string {
  try {
    // `JSON.stringify` returns **no** JSON for `undefined` and functions;
    // the type says `string`, the runtime `undefined`. Hence the detour via
    // `unknown` instead of a `??` that the type checker considers redundant.
    const text: unknown = JSON.stringify(value);
    return typeof text === 'string' ? text : String(value);
  } catch {
    return '[unserialisierbar]';
  }
}
