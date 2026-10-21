import type { AppSettings } from "./types.js";
import type { RequestErrorInfo } from "./types.js";
import { classifyWatermarkFailure, requestError } from "./request-diagnostics.js";
import { extractWatermarkUsage, watermarkScope, type WatermarkProviderObserver } from "./watermark-state.js";

export class WatermarkError extends Error {
  constructor(readonly info: RequestErrorInfo, message = `${info.title}：${info.detail}`) {
    super(message);
    this.name = "WatermarkError";
  }
}

const VIDEO_URL_KEYS = [
  "cleanVideoUrl",
  "videoUrl",
  "downloadUrl",
  "download_url",
  "playUrl",
  "play_url",
  "url"
];

const UNSUPPORTED_RE = /平台暂不支持|暂不支持|不支持该平台|unsupported platform|not supported/i;
// The provider may return before its clean MP4/CDN object is ready. Use a
// longer backoff so eventual-consistency responses are not treated as failures.
export const WATERMARK_RETRY_DELAYS_MS = [0, 5000, 15000, 30000, 60000] as const;
const REQUEST_TIMEOUT_MS = 20000;
const SHARE_PAGE_TIMEOUT_MS = 10000;

export interface WatermarkRetryInfo {
  failedAttempt: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  error: string;
  elapsedMs: number;
  configurationChanged?: boolean;
}

type WatermarkRetryCallback = (info: WatermarkRetryInfo) => void | Promise<void>;

export interface WatermarkResolveOptions {
  maxAttempts?: number;
  onProviderResponse?: WatermarkProviderObserver;
  getSettings?: () => AppSettings;
}

export function getWatermarkRetryDelays(
  maxAttempts: number = WATERMARK_RETRY_DELAYS_MS.length
) {
  const attemptCount = Math.max(
    1,
    Math.min(WATERMARK_RETRY_DELAYS_MS.length, Math.floor(maxAttempts))
  );
  return WATERMARK_RETRY_DELAYS_MS.slice(0, attemptCount);
}

export function hasDoubaoShareVideoResource(html: string) {
  if (!html.trim()) return false;

  const normalized = html
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/\\u002f/gi, "/");
  const hasCompletion = /你的视频(?:已经|已)?生成好[了啦]/.test(normalized);
  const hasVideoBlock = /creation_block|video_dsz(?:2)?_watermark|video_pre_watermark/i.test(normalized);
  const hasMp4 = /download_url/i.test(normalized)
    && /mime_type(?:\\+"|"|[^A-Za-z0-9]){0,12}video_mp4|video_type(?:\\+"|"|[^A-Za-z0-9]){0,12}mp4/i.test(normalized);
  return hasCompletion && hasVideoBlock && hasMp4;
}

export async function verifyDoubaoShareVideoResource(shareUrl: string) {
  let response: Response;
  try {
    response = await fetch(shareUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(SHARE_PAGE_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`复制出的豆包分享页无法访问：${errorMessage(error)}`);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`复制出的豆包分享页无法访问：HTTP ${response.status}`);
  }

  const html = await response.text();
  if (!hasDoubaoShareVideoResource(html)) {
    throw new Error("复制出的豆包分享页没有包含当前视频资源");
  }
}

export async function resolveCleanVideoUrl(
  settings: AppSettings,
  shareUrl: string,
  onRetry?: WatermarkRetryCallback,
  options: WatermarkResolveOptions = {}
) {
  let lastError: unknown;
  let nextDelayMs = 0;
  const startedAt = Date.now();
  const retryDelays = getWatermarkRetryDelays(options.maxAttempts);
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    if (nextDelayMs) await wait(nextDelayMs);
    const activeSettings = { ...(options.getSettings?.() || settings) };

    try {
      if (!activeSettings.watermarkApiToken.trim()) {
        throw new WatermarkError(classifyWatermarkFailure("未配置去水印 Token，无法返回可用视频"));
      }
      return await resolveCleanVideoUrlOnce(activeSettings, shareUrl, options.onProviderResponse);
    } catch (error) {
      lastError = error;
      const configurationChanged = watermarkScope(activeSettings) !== watermarkScope(options.getSettings?.() || settings);
      if (configurationChanged && attempt === retryDelays.length - 1) {
        throw new WatermarkError(requestError("watermark", "configuration_changed", "去水印配置已更换",
          "旧配置请求未成功，本次已到重试上限。", "使用已保存的新配置恢复结果，无需重新生成视频。", true));
      }
      if ((!configurationChanged && !isRetryableWatermarkError(error)) || attempt === retryDelays.length - 1) {
        throw error;
      }
      nextDelayMs = configurationChanged ? 0 : retryDelays[attempt + 1];
      await onRetry?.({
        failedAttempt: attempt + 1,
        nextAttempt: attempt + 2,
        maxAttempts: retryDelays.length,
        delayMs: nextDelayMs,
        configurationChanged,
        error: errorMessage(error),
        elapsedMs: Date.now() - startedAt
      });
    }
  }

  throw lastError;
}

async function resolveCleanVideoUrlOnce(settings: AppSettings, shareUrl: string, observer?: WatermarkProviderObserver) {
  let usage = null as ReturnType<typeof extractWatermarkUsage>;
  const notify = (error: RequestErrorInfo | null) => {
    try {
      observer?.(settings, { checkedAt: new Date().toISOString(), usage, error });
    } catch {
      // A statistics write must not turn a valid provider result into failure.
    }
  };
  try {
    const apiUrl = new URL(settings.watermarkApiUrl);
    apiUrl.searchParams.set("url", shareUrl);
    const upstream = await fetch(apiUrl, {
      headers: { Authorization: settings.watermarkApiToken },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const text = await upstream.text();
    const payload = parseJson(text);
    usage = extractWatermarkUsage(payload);
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    const providerCode = record?.code === undefined ? null : Number(record.code);
    const rawMessage = String(record?.message || record?.msg || (typeof payload === "string" ? payload : "解析失败"));
    const message = rawMessage.replaceAll(settings.watermarkApiToken, "[Token 已隐藏]").replace(/nologo_[A-Za-z0-9_-]+/g, "[Token 已隐藏]").slice(0, 800);
    if (!upstream.ok || providerCode !== null && Number.isFinite(providerCode) && providerCode !== 0 && providerCode !== 200) {
      throw new WatermarkError(classifyWatermarkFailure(message, upstream.ok ? providerCode || undefined : upstream.status));
    }
    if (UNSUPPORTED_RE.test(message) || UNSUPPORTED_RE.test(typeof payload === "string" ? payload : JSON.stringify(payload))) {
      throw new WatermarkError(classifyWatermarkFailure("平台暂不支持"));
    }
    const cleanVideoUrl = extractVideoUrlFromPayload(payload);
    if (!cleanVideoUrl) throw new WatermarkError(classifyWatermarkFailure("去水印接口没有返回 MP4 视频地址"));
    await verifyPlayableVideoUrl(cleanVideoUrl);
    notify(null);
    return cleanVideoUrl;
  } catch (error) {
    const typed = error instanceof WatermarkError ? error : new WatermarkError(classifyWatermarkFailure(errorMessage(error)));
    notify(typed.info);
    throw typed;
  }
}

export function isRetryableWatermarkError(error: unknown) {
  if (error instanceof WatermarkError) return error.info.retryable;
  const message = error instanceof Error ? error.message : String(error);
  if (UNSUPPORTED_RE.test(message)) return false;
  return /未找到资源|资源未就绪|处理中|稍后重试|解析失败|获取失败|没有返回 MP4|HTTP (?:404|408|409|425|429|5\d\d)|无法访问|不是可播放视频|fetch failed|network|timeout|aborted/i.test(message);
}

export function extractVideoUrlFromPayload(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  for (const key of VIDEO_URL_KEYS) {
    const item = record[key];
    if (typeof item === "string" && isMp4VideoUrl(item)) {
      return item;
    }
  }

  for (const item of Object.values(record)) {
    const result = extractVideoUrlFromPayload(item);
    if (result) return result;
  }
  return null;
}

export function isMp4VideoUrl(value: string) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return false;
    const decoded = decodeURIComponent(`${url.pathname}?${url.searchParams.toString()}`).toLowerCase();
    return decoded.includes(".mp4")
      || decoded.includes("video_mp4")
      || decoded.includes("video/mp4")
      || decoded.includes("format=mp4");
  } catch {
    return false;
  }
}

export async function verifyPlayableVideoUrl(url: string) {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Range: "bytes=0-1023" },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(`去水印视频地址无法访问：${errorMessage(error)}`);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const videoContent = contentType.startsWith("video/") || contentType.includes("application/octet-stream");
  await response.body?.cancel().catch(() => undefined);

  if (!response.ok || !videoContent) {
    throw new Error(`去水印结果不是可播放视频：HTTP ${response.status}，Content-Type ${contentType || "unknown"}`);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
