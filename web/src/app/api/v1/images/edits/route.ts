import { NextRequest } from "next/server";

// 图生图同样可能超过 30s，dev 模式走 Route Handler 透传 multipart 给后端；
// 生产模式由 next.config.ts 的 beforeFiles rewrites 优先匹配，跳过这里。
export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const API_BASE = process.env.API_BASE_URL || "http://127.0.0.1:8080";

export async function POST(req: NextRequest) {
  const headers: Record<string, string> = {};
  const contentType = req.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;
  const auth = req.headers.get("authorization");
  if (auth) headers.Authorization = auth;

  try {
    const upstream = await fetch(`${API_BASE}/api/v1/images/edits`, {
      method: "POST",
      headers,
      body: req.body,
      // 把浏览器侧的 abort 透传给后端：用户刷新 / 关页面 / 连点 abort 这个请求时，
      // req.signal 会 abort，这个 fetch 随之取消，后端 Go 的 r.Context() 取消 → 退还预扣额度，
      // 不再「客户端早走、后端跑完扣分」。
      signal: req.signal,
      // @ts-expect-error duplex 不在标准 RequestInit 类型里
      duplex: "half",
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
      },
    });
  } catch (error) {
    // 客户端已断开导致的 abort：响应也送不回去了，返回 499 占位避免 unhandled rejection 噪声。
    if (error instanceof Error && error.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    throw error;
  }
}
