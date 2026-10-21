export function quotaAmount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value * 10) / 10) : 0;
}

export function quotaRuns(remaining: number, cost: number): number {
  return Math.floor(Math.round(quotaAmount(remaining) * 10) / Math.max(10, Math.round(quotaAmount(cost) * 10)));
}
