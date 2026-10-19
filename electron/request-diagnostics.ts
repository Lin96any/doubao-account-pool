import type { ApiRequest, FailureStage, RequestErrorInfo } from "./types.js";

export function requestError(
  stage: FailureStage, code: string, title: string, detail: string, suggestion: string, retryable = false
): RequestErrorInfo {
  return { stage, code, title, detail, suggestion, retryable };
}

export function classifyWatermarkFailure(message: string, httpStatus?: number): RequestErrorInfo {
  const text = message.trim() || "服务商未提供错误原因";
  const make = (code: string, title: string, suggestion: string, retryable = false) =>
    requestError("watermark", code, title, text, suggestion, retryable);

  if (/(?:次数|额度|余额|配额).{0,12}(?:耗尽|用完|不足|为[零0])|insufficient.{0,12}(?:credit|balance|quota)|quota.{0,12}(?:exhausted|exceeded)/i.test(text)) {
    return make("quota_exhausted", "去水印次数已耗尽", "补充去水印次数后恢复结果，无需重新生成视频。");
  }
  if (/禁用|停用|disabled/i.test(text)) return make("token_disabled", "去水印 Token 已禁用", "联系服务商或更换可用 Token 后恢复结果。");
  if (/未配置|缺少.{0,12}token|missing.{0,12}token/i.test(text)) return make("token_missing", "未配置去水印 Token", "在配置管理中填写并保存 Token 后恢复结果。");
  if (/无效.{0,12}token|token.{0,12}(?:无效|失效|过期)|invalid.{0,12}token|expired|unauthorized/i.test(text) || httpStatus === 401) {
    return make("token_invalid", "去水印认证失败", "检查 Token 是否有效，保存正确配置后恢复结果。");
  }
  if (/暂不支持|不支持该平台|unsupported|not supported/i.test(text)) return make("unsupported_platform", "去水印服务不支持此链接", "检查分享链接和服务商支持范围，保留已生成视频。");
  if (httpStatus === 403 || /HTTP 403/.test(text)) return make("access_denied", "去水印授权被拒绝", "服务商未明确区分 Token 权限与剩余次数，请核对其原始回复。");
  if (httpStatus === 429 || /限流|过于频繁|too many requests|rate limit|HTTP 429/i.test(text)) {
    return make("rate_limited", "去水印请求受到限流", "等待后重试解析，无需重新生成视频。", true);
  }
  if (/未找到资源|资源未就绪|处理中|稍后重试|解析失败|获取失败|没有返回 MP4|HTTP (?:404|409|425)/i.test(text) || [404, 409, 425].includes(httpStatus || 0)) {
    return make("resource_pending", "视频解析资源暂未就绪", "保留当前分享地址，稍后恢复结果。", true);
  }
  if (httpStatus && httpStatus >= 500 || /HTTP 5\d\d|服务器内部错误|服务不可用/i.test(text)) {
    return make("service_unavailable", "去水印服务暂时异常", "服务恢复后重试解析。", true);
  }
  if (/timeout|timed out|aborted|fetch failed|network|无法访问|超时|网络/i.test(text)) {
    return make("network_error", "去水印网络请求失败", "检查网络或等待后恢复结果。", true);
  }
  if (/不是可播放视频|Content-Type|无效响应|JSON/i.test(text)) return make("invalid_video", "去水印未取得有效视频", "检查服务商返回内容，恢复结果前不会返回成功。", true);
  if (httpStatus === 400 || /URL参数|链接格式|invalid url/i.test(text)) return make("invalid_url", "去水印链接参数错误", "重新取得当前视频的有效分享链接。");
  return make("provider_error", "去水印解析失败", "按服务商原文检查原因；已有视频可稍后恢复结果。");
}

export function diagnoseRequest(message: string): RequestErrorInfo {
  if (/去水印(?:接口|服务|结果|视频地址| Token)|未配置去水印/.test(message)) return classifyWatermarkFailure(message);
  if (/未提取到.*分享链接|未复制到分享链接|分享面板|复制.*失败|分享.*同步/.test(message)) {
    return requestError("sharing", "share_unavailable", "未取得视频分享链接", message, "已有视频可恢复结果，无需重新生成。", true);
  }
  if (/没有可用账号|请求没有分配账号|账号不存在/.test(message)) return requestError("account", "account_unavailable", "暂无可用账号", message, "检查空闲账号、登录状态和豆包本地额度。");
  if (/未登录|登录失效|需要登录/.test(message)) return requestError("account", "login_required", "豆包账号需要登录", message, "打开对应账号重新登录。");
  if (/侵权|违规|无法返回该内容|换个主题/.test(message)) return requestError("generation", "content_rejected", "豆包拒绝生成内容", message, "按豆包回复调整内容后再提交。");
  if (/没有确认|未确认|提示词建议|未启动|提交确认/.test(message)) return requestError("submission", "not_started", "尚未确认视频任务启动", message, "检查当前对话的确认状态，避免重复提交原提示词。");
  if (/超时/.test(message)) return requestError("generation", "generation_timeout", "等待视频结果超时", message, "先检查原对话并恢复已有结果。", true);
  if (/下载|本地文件|输出目录/.test(message)) return requestError("output", "save_failed", "视频文件保存失败", message, "检查输出目录和下载网络后恢复结果。", true);
  return requestError("unknown", "unknown", "任务未完成", message, "查看执行步骤和原始回复确定原因。");
}

export function getRequestError(request: Pick<ApiRequest, "status" | "message" | "error">) {
  return request.status === "failed" ? request.error || diagnoseRequest(request.message) : null;
}

export const failureStageLabels: Record<FailureStage, string> = {
  account: "账号", submission: "生成确认", generation: "豆包生成", sharing: "复制分享", watermark: "去水印", output: "保存文件", unknown: "其他"
};

export function requestPhase(request: Pick<ApiRequest, "status" | "message" | "error">) {
  if (request.status === "success") return "视频已完成";
  if (request.status === "stopped") return "已停止";
  if (request.status === "failed") return getRequestError(request)?.title || "需要处理";
  const text = request.message;
  if (/去水印|解析|MP4/.test(text)) return /同步|未就绪|未拿到/.test(text) ? "等待解析资源" : "去水印解析";
  if (/分享|复制/.test(text)) return "复制视频分享";
  if (/尚未确认|补发|等待启动|确认生成/.test(text)) return "等待启动确认";
  if (/画幅|模型|填写|参考图|打开豆包/.test(text)) return "准备生成";
  if (/等待生成|等待视频|已提交豆包|确认视频结果/.test(text)) return "视频生成中";
  return request.status === "accepted" ? "等待处理" : "提交生成";
}
