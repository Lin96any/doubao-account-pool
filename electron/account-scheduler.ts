export interface AccountTask {
  key: string;
  accountId: number;
}

export class AccountTaskScheduler<T extends AccountTask> {
  private readonly pending: T[] = [];
  private readonly active = new Map<string, { accountId: number; lease: symbol }>();
  private draining = false;

  constructor(
    private readonly getConcurrency: () => number,
    private readonly worker: (item: T) => Promise<void | "retry">,
    private readonly onWorkerError: (error: unknown) => void = () => undefined,
    private readonly getAccountConcurrency: (accountId: number) => number = () => 1,
    private readonly canStart: (item: T) => boolean = () => true
  ) {}

  enqueue(item: T) {
    if (this.active.has(item.key) || this.pending.some((queued) => queued.key === item.key)) {
      return false;
    }
    this.pending.push(item);
    this.drain();
    return true;
  }

  cancel(key: string) {
    const index = this.pending.findIndex((item) => item.key === key);
    if (index >= 0) {
      this.pending.splice(index, 1);
      return true;
    }

    if (!this.active.delete(key)) return false;
    this.drain();
    return true;
  }

  isActive(key: string) {
    return this.active.has(key);
  }

  reassignPending(key: string, accountId: number) {
    const item = this.pending.find(item => item.key === key);
    if (!item) return false;
    item.accountId = accountId;
    this.drain();
    return true;
  }

  wake() { this.drain(); }

  private drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      const concurrency = Math.max(1, Math.trunc(this.getConcurrency()) || 1);
      while (this.active.size < concurrency) {
        const nextIndex = this.pending.findIndex(
          (item) => this.canStart(item) && Array.from(this.active.values()).filter((active) => active.accountId === item.accountId).length
            < Math.max(1, Math.trunc(this.getAccountConcurrency(item.accountId)) || 1)
        );
        if (nextIndex < 0) break;

        const [item] = this.pending.splice(nextIndex, 1);
        const lease = Symbol(item.key);
        this.active.set(item.key, { accountId: item.accountId, lease });
        let retry = false;

        void Promise.resolve()
          .then(() => this.worker(item))
          .then((result) => { retry = result === "retry"; })
          .catch((error) => this.onWorkerError(error))
          .finally(() => {
            // A cancelled worker may finish after a new execution has reused its key.
            if (this.active.get(item.key)?.lease !== lease) return;
            this.active.delete(item.key);
            if (retry && !this.pending.some((queued) => queued.key === item.key)) this.pending.push(item);
            this.drain();
          });
      }
    } finally {
      this.draining = false;
    }
  }
}
