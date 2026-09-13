import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CaughtMessage } from './smtp-catcher';

/**
 * **The one mail server of the instance that the whole run shares** — and the
 * channel through which a worker reads what it has received.
 *
 * ## Why a shared one instead of one per spec
 *
 * Since ADR-0024 **no account comes into being without an invitation**, and no
 * invitation without the mail server of the *installation*. With that, every
 * file that creates a person or an organisation with a fresh administrator needs
 * a set-up `system_setting` mail half — and that is an **installation-wide
 * single row**.
 *
 * The obvious way — every file starts its own catching server and enters its
 * port — fails on exactly that: `playwright.config.ts` runs `fullyParallel`, and
 * `login-rejection`, `tenant-admin` and `superadmin-overview` all lie in the
 * same desktop project. Three workers that write the same row to three different
 * ports are not a test, but a race.
 *
 * So **one for the whole run**: `global-setup.ts` starts it in the main process
 * (there, where Playwright lives anyway until the last worker is finished),
 * `auth.setup.ts` enters it once, and every worker looks up here what has
 * arrived.
 *
 * ## Why a file and not an import
 *
 * Because Playwright workers are **processes of their own**. The `messages`
 * field of an `SmtpCatcher` lives in the main process and is visible to nobody
 * from outside it. What both sides can share is the file tree — hence one
 * appended line per message (JSONL) and a small file with the port.
 *
 * Appending happens **only from the main process**, reading from everyone: one
 * writer, arbitrarily many readers, so no locking problem. A half-written last
 * line is passed over on reading instead of throwing — the next pass of the
 * query sees it complete. A **complete** line of a different shape, on the other
 * hand, is not an intermediate stage but a find: it throws, and namely with the
 * file in the text (`asStoredMessage`).
 *
 * ## What does **not** belong here
 *
 * No replacement for the catching servers of the two acceptance runs
 * (`durchlauf-organisationen.spec.ts`, `durchlauf-funktionsumfang.spec.ts`).
 * Those run in serial projects of their own, expressly set up the mail server
 * themselves and measure precisely on that, **which** server has received a
 * mail. This one here is the ground state on which the rest of the suite stands.
 */

/** `.playwright/` is already in `.gitignore` — like the parked sessions. */
const LOG_FILE = fileURLToPath(
  new URL('../.playwright/mail/instance-mail.jsonl', import.meta.url),
);

const PORT_FILE = fileURLToPath(
  new URL('../.playwright/mail/instance-mail-port.json', import.meta.url),
);

/** A caught message, the way it lies on the disk. */
export interface StoredMessage extends CaughtMessage {
  /** ISO-8601, from the clock of the main process — only for troubleshooting. */
  readonly at: string;
}

/**
 * Empties the channel and deposits the port — the first step of
 * `global-setup.ts`, before the first test even runs.
 *
 * Emptied, not appended to: what an earlier run caught is no evidence for this
 * one. Exactly the same attitude that `reset-data` takes towards the database —
 * **`pnpm e2e` owns the state it points at.**
 */
export function openInstanceMailStore(port: number): void {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  writeFileSync(LOG_FILE, '', 'utf8');
  writeFileSync(PORT_FILE, `${JSON.stringify({ port })}\n`, 'utf8');
}

/** Appends a caught message — **only** from the main process. */
export function recordInstanceMail(message: CaughtMessage): void {
  const stored: StoredMessage = {
    from: message.from,
    to: [...message.to],
    data: message.data,
    at: new Date().toISOString(),
  };
  appendFileSync(LOG_FILE, `${JSON.stringify(stored)}\n`, 'utf8');
}

/**
 * The port on which the catching server of this run listens.
 *
 * Throws instead of delivering `null`: whoever asks here wants to enter a mail
 * server right away, and a `null` would be passed on as „port 0" or as an empty
 * field. The message names the cause that it practically always is — a call
 * without `globalSetup`.
 */
export function instanceMailPort(): number {
  let raw: string;
  try {
    raw = readFileSync(PORT_FILE, 'utf8');
  } catch {
    throw new Error(
      `[e2e] ${PORT_FILE} gibt es nicht. Den Auffangserver der Instanz ` +
        'startet `e2e/global-setup.ts`; ein Lauf ohne globalSetup (etwa ' +
        '`playwright test --no-deps` gegen eine einzelne Datei) hat keinen.',
    );
  }
  const parsed: unknown = JSON.parse(raw);
  const port =
    typeof parsed === 'object' && parsed !== null
      ? (Object.getOwnPropertyDescriptor(parsed, 'port')?.value as unknown)
      : undefined;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
    throw new Error(`[e2e] ${PORT_FILE} nennt keinen Port: ${raw}`);
  }
  return port;
}

/**
 * Everything the catching server has received so far.
 *
 * If the file is missing, the answer is the empty list and **no** exception:
 * „nothing has arrived yet" is a valid intermediate state of every query that is
 * waiting for the queue to move.
 */
export function readInstanceMail(): readonly StoredMessage[] {
  let raw: string;
  try {
    raw = readFileSync(LOG_FILE, 'utf8');
  } catch {
    return [];
  }

  const messages: StoredMessage[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A last line that has been begun — the next pass sees it whole.
      continue;
    }
    const message = asStoredMessage(parsed);
    if (message === null) {
      throw new Error(
        `[e2e] ${LOG_FILE} trägt eine Zeile, die keine aufgefangene Nachricht ` +
          `ist: ${line.slice(0, 200)}. Geschrieben wird diese Datei allein von ` +
          '`recordInstanceMail()` im Hauptprozess; steht hier etwas anderes, ' +
          'liegt ein fremder Rückstand im Baum — und jede Abfrage darüber ' +
          'suchte in Feldern, die es nicht gibt.',
      );
    }
    messages.push(message);
  }
  return messages;
}

/**
 * Foreign data from the disk, checked instead of asserted.
 *
 * **Without Zod, and that is on purpose.** This project deliberately keeps
 * `@formsache/shared` — and thereby Zod — out of `e2e/` (`api-dev.spec.ts`
 * justifies it); the suite is supposed to measure the application from the
 * outside and not share its types. What `AGENTS.md` demands is the *attitude*:
 * `unknown` in, checked out — here with the same hand-written check that
 * `instanceMailPort()` already does a few lines higher.
 *
 * The `try` above only catches the **half-written** last line. A complete line
 * of a different shape passed through as a `StoredMessage` before — a cast that
 * nothing had checked —, and `message.to.includes(…)` would then have flown at
 * `undefined`, with a message about `to` instead of about the file.
 *
 * Returns `null` instead of throwing itself: the message belongs at the place
 * that knows which file the line comes from.
 */
function asStoredMessage(value: unknown): StoredMessage | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { from, to, data, at } = record;
  if (
    typeof from !== 'string' ||
    typeof data !== 'string' ||
    typeof at !== 'string' ||
    !Array.isArray(to) ||
    to.some((entry) => typeof entry !== 'string')
  ) {
    return null;
  }
  return { from, to: to as readonly string[], data, at };
}
