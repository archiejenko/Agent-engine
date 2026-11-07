/** Email, alerts, queues. Fakes record everything; nothing leaves the system. */
export interface OutboundEmail {
  to: string;
  from: string;
  subject: string;
  body: string;
  headers?: Record<string, string>;
  task_id?: string;
}

export interface EmailSender {
  readonly name: string;
  /** dryRun=true means: record it, don't send (the default while the kill switch is on). */
  send(msg: OutboundEmail, dryRun: boolean): Promise<{ id: string; delivered: boolean }>;
}

export class FakeEmailSender implements EmailSender {
  readonly name = "fake-email";
  sent: (OutboundEmail & { id: string; dryRun: boolean })[] = [];
  async send(msg: OutboundEmail, dryRun: boolean) {
    const id = crypto.randomUUID();
    this.sent.push({ ...msg, id, dryRun });
    return { id, delivered: !dryRun };
  }
}

export interface InboundEmail {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  received_at: string;
  in_reply_to: string | null;
}

export interface Inbox {
  poll(since: string): Promise<InboundEmail[]>;
}

export class FakeInbox implements Inbox {
  constructor(public messages: InboundEmail[] = []) {}
  async poll(since: string) {
    return this.messages.filter((m) => m.received_at > since);
  }
}

export interface AlertChannel {
  send(
    alert: { kind: string; target: string; payload: unknown },
    dryRun: boolean,
  ): Promise<{ delivered: boolean }>;
}

export class FakeAlertChannel implements AlertChannel {
  delivered: { kind: string; target: string; payload: unknown; dryRun: boolean }[] = [];
  async send(alert: { kind: string; target: string; payload: unknown }, dryRun: boolean) {
    this.delivered.push({ ...alert, dryRun });
    return { delivered: !dryRun };
  }
}

/** Queue port: Cloudflare Queues at cutover; in-memory now. */
export interface QueueBus {
  send(queue: string, body: unknown): Promise<void>;
  receive(queue: string, max: number): Promise<unknown[]>;
}

export class InMemoryQueue implements QueueBus {
  queues = new Map<string, unknown[]>();
  async send(queue: string, body: unknown) {
    this.queues.set(queue, [...(this.queues.get(queue) ?? []), body]);
  }
  async receive(queue: string, max: number) {
    const q = this.queues.get(queue) ?? [];
    const out = q.splice(0, max);
    return out;
  }
}
