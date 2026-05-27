import { apiDelete, apiGet, apiPost } from "@/services/api/request";

export type Agent = {
  id: string;
  userId: string;
  name: string;
  avatarUrl: string;
  description: string;
  systemPrompt: string;
  defaultSize: string;
  defaultQuality: string;
  // 角色绑定的固定参考图（可选，最多 3 张）：每次生图都会按顺序把它们作为 references
  // 一起发到上游 /v1/images/edits。只存 storageKey，渲染时统一走 imageUrl(key) 直链。
  referenceImageKeys: string[];
  usageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AgentListResponse = {
  items: Agent[];
  total: number;
};

export async function fetchMyAgents(token: string) {
  return apiGet<AgentListResponse>("/api/agents/me", undefined, token);
}

export async function saveMyAgent(token: string, agent: Partial<Agent>) {
  return apiPost<Agent>("/api/agents/me", agent, token);
}

export async function deleteMyAgent(token: string, id: string) {
  return apiDelete<boolean>(`/api/agents/me/${encodeURIComponent(id)}`, token);
}
