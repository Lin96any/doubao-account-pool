const DAY_MS = 86400000;
const BEIJING_OFFSET_MS = 8 * 3600000;

export function quotaDate(date = new Date()): string {
  return new Date(date.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

export function nextQuotaReset(date = new Date()): string {
  const day = Date.parse(`${quotaDate(date)}T00:00:00.000Z`);
  return new Date(day + DAY_MS - BEIJING_OFFSET_MS).toISOString();
}

export class DailyQuotaTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(private readonly check: () => void, private readonly clock: () => Date = () => new Date()) {}

  start() {
    this.stopped = false;
    this.refresh();
  }

  refresh() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    try { this.check(); } finally {
      if (!this.stopped) {
        const delay = Date.parse(nextQuotaReset(this.clock())) - this.clock().getTime();
        this.timer = setTimeout(() => this.refresh(), Math.max(1, Math.min(60000, delay)));
      }
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
