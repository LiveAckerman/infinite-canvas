import { apiDelete, apiGet, apiPost } from "@/services/api/request";

// 跟后端 AgentWorkstationCardStatus 对齐。running 状态由后端 generation 任务承载，刷新页面也能续上轮询。
export type AgentWorkstationCardStatus = "idle" | "running" | "success" | "failed";

export type AgentWorkstationCard = {
  id: string;
  userId: string;
  agentId: string;
  position: number;
  referenceKeys?: string[];
  extraNote?: string;
  outputKey?: string;
  status: AgentWorkstationCardStatus;
  // status=running 时关联的那条 generation id（POST /api/generations/run 返回）。
  // 前端按这个 id 轮询拿进度；刷新 / 重进卡片都能据此续上。终态时由后端清空。
  runningGenerationId?: string;
  errorMessage?: string;
  durationMs?: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentWorkstationCardListResponse = {
  items: AgentWorkstationCard[];
  total: number;
};

export async function fetchMyAgentWorkstationCards(token: string) {
  return apiGet<AgentWorkstationCardListResponse>("/api/agent-workstations/me", undefined, token);
}

// upsert：「加入工作区」「上传原图」「写附加说明」「跑完成功 / 失败」「重置」都走这一个 POST，
// 后端按 (userId, agentId) 去重，自动认成 update 或 insert。
export async function saveMyAgentWorkstationCard(token: string, card: Partial<AgentWorkstationCard>) {
  return apiPost<AgentWorkstationCard>("/api/agent-workstations/me", card, token);
}

export async function deleteMyAgentWorkstationCard(token: string, id: string) {
  return apiDelete<boolean>(`/api/agent-workstations/me/${encodeURIComponent(id)}`, token);
}
