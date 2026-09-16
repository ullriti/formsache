import { Injectable } from '@nestjs/common';
import {
  ACK_DURATION_MS,
  type AcknowledgeAlertRequest,
  type OpsMetricName,
  type OpsStatus,
} from '@formsache/shared';

import { MailClock } from '../mail/mail-clock';
import { PrismaService } from '../prisma/prisma.service';
import { NO_ACKNOWLEDGEMENT } from './ops-alert.service';
import { OpsStatusService } from './ops-status.service';

/**
 * **Quittieren** — the write path behind the monitoring view (ADR-0016,
 * continuation 2026-09-16).
 *
 * An acknowledgement silences one metric; it does not fix anything, and the
 * traffic light stays red. Its whole purpose is that a known, already
 * scheduled problem stops mailing four times a day until somebody gets round
 * to it.
 *
 * Both calls answer with the **whole** operations status rather than the one
 * row they touched: the view redraws from it anyway, and a reply that named
 * only the acknowledged metric would leave the page a tick out of date on
 * every other figure.
 */
@Injectable()
export class OpsAcknowledgementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: MailClock,
    private readonly status: OpsStatusService,
  ) {}

  /**
   * ⚠️ **The end of the span is computed here, never sent.** A client that
   * named its own `until` could silence a metric for a decade; what it gets to
   * choose is one of four spans.
   */
  async acknowledge(
    metric: OpsMetricName,
    request: AcknowledgeAlertRequest,
    userId: string,
  ): Promise<OpsStatus> {
    const acknowledgedAt = this.clock.now();
    const span = ACK_DURATION_MS[request.duration];
    const acknowledgement = {
      acknowledgedAt,
      acknowledgedUntil:
        span === null ? null : new Date(acknowledgedAt.getTime() + span),
      acknowledgedById: userId,
      // An empty note is no note — it would otherwise stand in the view as an
      // empty pair of quotation marks.
      acknowledgedNote:
        request.note === undefined || request.note === '' ? null : request.note,
    };
    await this.prisma.opsAlert.upsert({
      where: { metric },
      // The row may not exist yet: a metric can be over its threshold before
      // it has ever reported (no operator address, or simply the same tick).
      create: { metric, ...acknowledgement },
      update: acknowledgement,
    });
    return this.status.read();
  }

  /**
   * Takes an acknowledgement back — the metric reports again from the next
   * tick, subject to the ordinary repeat suppression.
   *
   * `updateMany` and not `update`: a metric that was never acknowledged is not
   * an error here, it is the state the caller wants.
   */
  async release(metric: OpsMetricName): Promise<OpsStatus> {
    await this.prisma.opsAlert.updateMany({
      where: { metric },
      data: NO_ACKNOWLEDGEMENT,
    });
    return this.status.read();
  }
}
