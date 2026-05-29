import { NextRequest } from "next/server";

// 生图请求耗时通常几十秒到几分钟，next dev rewrites 有 30s 代理超时，
// 这里改走 Route Handler 自己 fetch 后端绕过该限制。生产模式由 next.config.ts
// 的 beforeFiles rewrites 优先匹配，跳过这里。
export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const API_BASE = process.env.API_BASE_URL || "http://127.0.0.1:8080";

export async function POST(req: NextRequest) {
  const headers: Record<string, string> = {
    "Content-Type": req.headers.get("content-type") || "application/json",
  };
  const auth = req.headers.get("authorization");
  if (auth) headers.Authorization = auth;

  try {
    const upstream = await fetch(`${API_BASE}/api/v1/images/generations`, {
      method: "POST",
      headers,
      body: req.body,
      // 把浏览器侧的 abort 透传给后端：客户端断开时后端 r.Context() 取消 → 退还预扣额度。
      signal: req.signal,
      // Node 18+ 流式 body 必须声明 duplex；TS 类型暂未收录该字段。
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
    if (error instanceof Error && error.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    throw error;
  }
}
