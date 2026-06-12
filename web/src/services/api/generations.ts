import { apiDelete, apiGet, apiPost, compactApiParams } from "@/services/api/request";

export type GenerationMode = "image" | "edit";
export type GenerationStatus = "running" | "success" | "partial" | "failed";

export type GenerationRecord = {
  id: string;
  userId: string;
  prompt: string;
  mode: GenerationMode;
  model: string;
  size: string;
  quality: string;
  count: number;
  successCount: number;
  failCount: number;
  durationMs: number;
  status: GenerationStatus;
  thumbnails: string[];
  references: string[];
  // 失败 slot 的错误信息列表（每个失败一条）
  errors?: string[];
  // 调用反代时实际带的请求参数（mode、size、quality、n、references 数量等），仅供 admin 审计
  requestParams?: Record<string, unknown>;
  // 最近一次反代上游响应 raw JSON 字符串（去掉 b64_json 后），仅供 admin 审计
  upstreamMeta?: string;
  // 微调来源：指向被微调的源 generation.id；为空表示原始生成
  parentId?: string;
  // 角色工作台发起时记录所用角色 id；为空表示常规 /image 工作台或 canvas 发起。
  agentId?: string;
  createdAt: string;
};

export type GenerationListResponse = {
  items: GenerationRecord[];
  total: number;
};

export type GenerationQuery = {
  page?: number;
  pageSize?: number;
  // 仅看指定 agent 的生成记录（角色工作台 Drawer 用）
  agentId?: string;
  // "1" → 只看「来自角色工作台」的记录（agent_id 非空）；与 agentId 同时存在时 agentId 生效
  hasAgent?: string;
  // "1" → 排除「来自角色工作台」的记录（agent_id 为空 / null）；/image 工作台左侧列表用。
  // 优先级：agentId > hasAgent > excludeAgent，同时存在时按这个顺序应用。
  excludeAgent?: string;
};

export type SaveGenerationPayload = {
  id?: string;
  prompt: string;
  mode: GenerationMode;
  model: string;
  size: string;
  quality: string;
  count: number;
  successCount: number;
  failCount: number;
  durationMs: number;
  status: GenerationStatus;
  thumbnails: string[];
  references: string[];
  errors?: string[];
  requestParams?: Record<string, unknown>;
  upstreamMeta?: string;
  parentId?: string;
  agentId?: string;
};

// 后端任务化生图发起入参。id 非空 = 追加到已有记录（二次生成累加）；parentId = 微调来源；
// agentId 由角色工作台传入，让记录归属到那个角色，方便按 agent 过滤。
export type RunGenerationPayload = {
  id?: string;
  prompt: string;
  mode: GenerationMode;
  size: string;
  quality: string;
  count: number;
  references: string[];
  parentId?: string;
  agentId?: string;
};

export async function fetchGenerations(token: string, query: GenerationQuery = {}) {
  return apiGet<GenerationListResponse>("/api/generations", compactApiParams(query), token);
}

export async function saveGeneration(token: string, payload: SaveGenerationPayload) {
  return apiPost<GenerationRecord>("/api/generations", payload, token);
}

export async function deleteGeneration(token: string, id: string) {
  return apiDelete<boolean>(`/api/generations/${encodeURIComponent(id)}`, token);
}

// 发起一次后端任务化生图：后端建（或追加）一条 running 记录 + 起后台任务，立即返回该记录。
// 前端随后轮询 fetchGeneration 拿进度，刷新 / 关页面都不影响后台继续生成。
export async function runGeneration(token: string, payload: RunGenerationPayload) {
  return apiPost<GenerationRecord>("/api/generations/run", payload, token);
}

// 轮询单条生图记录的最新状态（owner 校验）。
export async function fetchGeneration(token: string, id: string) {
  return apiGet<GenerationRecord>(`/api/generations/${encodeURIComponent(id)}`, undefined, token);
}

// 重试一条记录里的失败槽（后端删一条 error、置 running、后台补跑一张）。
export async function retryGeneration(token: string, id: string) {
  return apiPost<GenerationRecord>("/api/generations/retry", { id }, token);
}
