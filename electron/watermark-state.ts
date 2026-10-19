import { createHash } from "node:crypto";
import type { AppSettings, RequestErrorInfo, WatermarkStatus, WatermarkUsage } from "./types.js";

export interface WatermarkProviderEvent {
  checkedAt: string;
  usage: WatermarkUsage | null;
  error: RequestErrorInfo | null;
}

export type WatermarkProviderObserver = (settings: AppSettings, event: WatermarkProviderEvent) => void;

export function watermarkScope(settings: Pick<AppSettings, "watermarkApiUrl" | "watermarkApiToken">) {
  return createHash("sha256").update(`${settings.watermarkApiUrl.trim()}\n${settings.watermarkApiToken.trim()}`).digest("hex");
}

export function extractWatermarkUsage(payload: unknown): WatermarkUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : record;
  const usage = data.usage;
  if (!usage || typeof usage !== "object") return null;
  const source = usage as Record<string, unknown>;
  const count = (value: unknown) => {
    if (typeof value !== "number" && typeof value !== "string" || String(value).trim() === "") return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  };
  const result = { totalLimit: count(source.totalLimit), usedCount: count(source.usedCount), remainingCount: count(source.remainingCount) };
  return Object.values(result).some((value) => value !== null) ? result : null;
}

export function mergeWatermarkStatus(previous: WatermarkStatus | null, event: WatermarkProviderEvent): WatermarkStatus {
  if (previous?.checkedAt && event.checkedAt < previous.checkedAt) return previous;
  return {
    configured: true,
    usage: event.usage || previous?.usage || null,
    checkedAt: event.checkedAt,
    usageUpdatedAt: event.usage ? event.checkedAt : previous?.usageUpdatedAt || null,
    error: event.error
  };
}
