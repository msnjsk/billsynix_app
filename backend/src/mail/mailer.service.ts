import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export type Mail = { to: string; subject: string; text: string };

/**
 * Outgoing email. Phase 3 ships a log-only transport; Phase 11 plugs in a real provider behind
 * the same `send()`. In production nothing sensitive (reset links) is ever written to logs.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger('Mailer');
  /** Last messages sent, for development and tests (never kept in production). */
  readonly outbox: (Mail & { from: string; at: Date })[] = [];

  constructor(@Inject(ENV) private readonly env: Env) {}

  async send(mail: Mail): Promise<void> {
    if (this.env.NODE_ENV === 'production') {
      this.logger.warn(
        { subject: mail.subject },
        'No email provider configured — message not delivered',
      );
      return;
    }
    this.outbox.push({ ...mail, from: this.env.MAIL_FROM, at: new Date() });
    if (this.outbox.length > 50) this.outbox.shift();
    this.logger.log(
      { to: mail.to, subject: mail.subject, text: mail.text },
      'Email (development transport)',
    );
  }
}
