import { apiDelete, apiGet, apiPost } from "@/services/api/request";

// 跟后端 AgentWorkstationCardStatus 对齐——running 不入库，前端运行中状态只活在内存里。
export type AgentWorkstationCardStatus = "idle" | "success" | "failed";

export type AgentWorkstationCard = {
  id: string;
  userId: string;
  agentId: string;
  position: number;
  referenceKey?: string;
  extraNote?: string;
  outputKey?: string;
  status: AgentWorkstationCardStatus;
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
