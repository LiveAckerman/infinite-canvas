import { apiPost } from "@/services/api/request";

// 调用后端反代的「提示词优化」端点。
// 后端会注入隐藏的 system prompt + 启用配置的 textModel，前端只能拿到 improved。
export async function improvePrompt(token: string, prompt: string) {
  const data = await apiPost<{ improved: string }>("/api/prompts/improve", { prompt }, token);
  return data.improved;
}
