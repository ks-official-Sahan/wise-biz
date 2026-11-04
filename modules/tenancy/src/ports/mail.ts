/**
 * Narrow port to outgoing mail. Structurally matches @wise-biz/mailer's Mailer, so the workers inject the real one
 * while tenancy never imports the mailer package.
 */
export interface MailSender {
  send(msg: {
    readonly to: string;
    readonly subject: string;
    readonly text: string;
    readonly html?: string;
  }): Promise<void>;
}
