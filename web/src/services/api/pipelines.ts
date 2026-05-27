import { apiDelete, apiGet, apiPost } from "@/services/api/request";

export type PipelineStepDef = {
  // 客户端生成的稳定 id，跨刷新 / 重命名后顺序的 React key + 拖拽 sortable id 都靠它
  stepId: string;
  agentId: string;
  extraNote: string;
};

export type Pipeline = {
  id: string;
  userId: string;
  name: string;
  description: string;
  steps: PipelineStepDef[];
  createdAt: string;
  updatedAt: string;
};

export type PipelineListResponse = {
  items: Pipeline[];
  total: number;
};

export async function fetchMyPipelines(token: string) {
  return apiGet<PipelineListResponse>("/api/pipelines/me", undefined, token);
}

export async function saveMyPipeline(token: string, pipeline: Partial<Pipeline>) {
  return apiPost<Pipeline>("/api/pipelines/me", pipeline, token);
}

export async function deleteMyPipeline(token: string, id: string) {
  return apiDelete<boolean>(`/api/pipelines/me/${encodeURIComponent(id)}`, token);
}
