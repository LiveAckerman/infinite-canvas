import axios from "axios";

import { type AiConfig } from "@/lib/ai-config";
import { createId } from "@/lib/id";
import { dataUrlToFile } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

export type ChatCompletionMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type UpstreamImageItem = Record<string, unknown>;

type UpstreamImageResponse = {
  data?: UpstreamImageItem[];
};

type ImageProxyResult = {
  upstream: UpstreamImageResponse | null;
  remaining: number;
  upstreamMeta?: string;
};

type ApiEnvelope<T> = {
  code: number;
  data: T;
  msg: string;
};

export type GeneratedImage = { id: string; dataUrl: string };

export type GenerationResult = {
  images: GeneratedImage[];
  remaining: number;
  // 后端反代返回的上游响应 raw JSON 字符串（已去除 b64_json 大字段），供 admin 审计落库使用。
  upstreamMeta?: string;
};

function resolveImageDataUrl(item: UpstreamImageItem) {
  if (typeof item.b64_json === "string" && item.b64_json) {
    return `data:image/png;base64,${item.b64_json}`;
  }
  if (typeof item.url === "string" && item.url) {
    return item.url;
  }
  return null;
}

function parseImageResult(result: ImageProxyResult): GenerationResult {
  const images =
    result.upstream?.data
      ?.map(resolveImageDataUrl)
      .filter((value): value is string => Boolean(value))
      .map((dataUrl) => ({ id: createId(), dataUrl })) || [];

  if (images.length === 0) {
    throw new Error("接口没有返回图片");
  }

  if (result.remaining >= 0) {
    useUserStore.getState().setCredits(result.remaining);
  }

  return { images, remaining: result.remaining, upstreamMeta: result.upstreamMeta };
}

// 413 是 nginx 在请求体过大时直接拒绝；此时返回的不是项目自定义 envelope，
// 需要单独识别并给出中文提示，否则用户只能看到"请求失败：413"这种无意义信息。
const OVERSIZE_REQUEST_TIP = "请求体过大（超过 50MB），请压缩参考图或减少同时上传的图片数量";

function describeStatus(status?: number, fallback = "请求失败") {
  if (status === 413) return OVERSIZE_REQUEST_TIP;
  if (status === 401) return "请先登录或重新登录";
  if (status === 504) return "服务器响应超时，请稍后再试";
  return status ? `${fallback}：${status}` : fallback;
}

// 从 envelope 里挖错误文案。envelope.msg 是后端 Fail() 写的中文错误（用户最关心的内容），
// 优先级永远高于 fallback。code === 0 但 msg 非空时也照样返回 msg（极少见，做防御处理）。
function readEnvelopeError<T>(envelope: ApiEnvelope<T> | undefined, fallback: string, status?: number) {
  if (envelope && typeof envelope === "object") {
    const msg = typeof envelope.msg === "string" ? envelope.msg.trim() : "";
    if (msg && msg !== "ok") return msg;
  }
  return describeStatus(status, fallback);
}

// 只在「axios 自己抛错（网络层 / 取消 / DNS 等）」时才会调到这里——
// 因为我们的请求统一用 `validateStatus: () => true`，HTTP 4xx/5xx 不会让 axios 抛错，
// 走的是 envelope 解析路径。这里专门处理「拿不到任何 response」的退化情形：
//   1. AxiosError 带 response → 仍尝试从 response.data 里挖 envelope.msg
//   2. AxiosError 没 response（网络断 / 超时 / CORS）→ 用 describeStatus 兜底
//   3. 不是 AxiosError 也不是 Error → fallback 兜底
function readAxiosError(error: unknown, fallback: string) {
  if (axios.isAxiosError<ApiEnvelope<unknown>>(error)) {
    const envelope = error.response?.data;
    if (envelope && typeof envelope === "object") {
      const msg = typeof envelope.msg === "string" ? envelope.msg.trim() : "";
      if (msg && msg !== "ok") return msg;
    }
    return describeStatus(error.response?.status, fallback);
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function authHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...(extra || {}) };
}

function parseStreamChunk(chunk: string, onDelta: (value: string) => void) {
  let deltaText = "";
  for (const eventBlock of chunk.split("\n\n")) {
    const data = eventBlock.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    if (!data || data === "[DONE]") continue;
    const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content || "";
    deltaText += delta;
  }
  if (deltaText) onDelta(deltaText);
}

export async function requestGeneration(token: string, config: AiConfig, prompt: string): Promise<GenerationResult> {
  const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
  // 拆成两段：先做 axios 调用、只 catch「网络层失败」；然后解析 envelope
  // 直接 throw 不再被外层 catch 重新包装吃掉 msg。
  let response;
  try {
    response = await axios.post<ApiEnvelope<ImageProxyResult>>(
      "/api/v1/images/generations",
      {
        prompt,
        n,
        quality: config.quality || undefined,
        size: config.size || undefined,
      },
      {
        headers: authHeaders(token, { "Content-Type": "application/json" }),
        validateStatus: () => true,
      },
    );
  } catch (error) {
    throw new Error(readAxiosError(error, "请求失败"));
  }
  if (!response.data || typeof response.data !== "object") {
    throw new Error(describeStatus(response.status, "请求失败"));
  }
  if (response.data.code !== 0) {
    // 后端 Fail() 写的 envelope.msg（例如「额度不足，请联系管理员」）直接给用户。
    // console.error 是调试线索：万一某天又有人改坏了消息流，DevTools 能立刻看到原始 envelope。
    console.error("/api/v1/images/generations 失败", response.data);
    throw new Error(readEnvelopeError(response.data, "请求失败", response.status));
  }
  return parseImageResult(response.data.data);
}

export async function requestEdit(token: string, config: AiConfig, prompt: string, references: ReferenceImage[]): Promise<GenerationResult> {
  const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));

  // 优先路径：所有参考图都已经在服务器图床（有 storageKey）→ 走 JSON，
  // 请求体只有几百字节，后端按 owner 校验后直接读磁盘转 multipart 上送。
  const allOnServer = references.length > 0 && references.every((ref) => Boolean(ref.storageKey));
  if (allOnServer) {
    let response;
    try {
      response = await axios.post<ApiEnvelope<ImageProxyResult>>(
        "/api/v1/images/edits",
        {
          prompt,
          n,
          quality: config.quality || undefined,
          size: config.size || undefined,
          references: references.map((ref) => ref.storageKey),
        },
        {
          headers: authHeaders(token, { "Content-Type": "application/json" }),
          validateStatus: () => true,
        },
      );
    } catch (error) {
      throw new Error(readAxiosError(error, "请求失败"));
    }
    if (!response.data || typeof response.data !== "object") {
      throw new Error(describeStatus(response.status, "请求失败"));
    }
    if (response.data.code !== 0) {
      console.error("/api/v1/images/edits (JSON) 失败", response.data);
      throw new Error(readEnvelopeError(response.data, "请求失败", response.status));
    }
    return parseImageResult(response.data.data);
  }

  // 兜底路径：有 reference 还没上传过（画布瞬时截屏 / 裁剪结果），走传统 multipart。
  const formData = new FormData();
  formData.set("prompt", prompt);
  formData.set("n", String(n));
  if (config.quality) {
    formData.set("quality", config.quality);
  }
  if (config.size) {
    formData.set("size", config.size);
  }
  const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
  files.forEach((file) => formData.append("image", file));

  let response;
  try {
    response = await axios.post<ApiEnvelope<ImageProxyResult>>("/api/v1/images/edits", formData, {
      headers: authHeaders(token),
      validateStatus: () => true,
    });
  } catch (error) {
    throw new Error(readAxiosError(error, "请求失败"));
  }
  if (!response.data || typeof response.data !== "object") {
    throw new Error(describeStatus(response.status, "请求失败"));
  }
  if (response.data.code !== 0) {
    console.error("/api/v1/images/edits (multipart) 失败", response.data);
    throw new Error(readEnvelopeError(response.data, "请求失败", response.status));
  }
  return parseImageResult(response.data.data);
}

export async function requestImageQuestion(token: string, messages: ChatCompletionMessage[], onDelta: (text: string) => void) {
  let buffer = "";
  let answer = "";
  let processedLength = 0;

  try {
    await axios.post(
      "/api/v1/chat/completions",
      {
        messages,
        stream: true,
      },
      {
        headers: authHeaders(token, { "Content-Type": "application/json" }),
        responseType: "text",
        validateStatus: () => true,
        onDownloadProgress: (event) => {
          const responseText = String(event.event?.target?.responseText || "");
          const nextText = responseText.slice(processedLength);
          processedLength = responseText.length;
          buffer += nextText;
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() || "";
          for (const chunk of chunks) {
            parseStreamChunk(chunk, (delta) => {
              answer += delta;
              onDelta(answer);
            });
          }
        },
      },
    );
    if (buffer) {
      parseStreamChunk(buffer, (delta) => {
        answer += delta;
        onDelta(answer);
      });
    }
  } catch (error) {
    throw new Error(readAxiosError(error, "请求失败"));
  }
  return answer || "没有返回内容";
}
