import type { RequestErrorInfo } from "./types.js";

export function isDoubaoDailyQuotaExhausted(value: string | null | undefined): boolean {
  const text = (value || "").replace(/[\s*]+/g, "");
  if (/去水印|解析次数|侵权|违规/.test(text)) return false;
  return /(?:今日|今天)(?:的)?(?:视频)?(?:生成)?(?:免费)?(?:生成)?次数(?:已经|已)?(?:用完|耗尽)/.test(text)
    || /免费(?:视频)?(?:生成)?次数(?:已经|已)?(?:用完|耗尽).{0,24}明天/.test(text);
}

export function doubaoDailyQuotaError(detail: string): RequestErrorInfo {
  return {
    stage: "account",
    code: "doubao_daily_quota_exhausted",
    title: "豆包今日免费次数已用完",
    detail,
    suggestion: "使用其他有额度的账号，或北京时间次日 00:00 后重试。",
    retryable: false
  };
}
