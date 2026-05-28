import { apiDelete, apiGet, apiPost } from "@/services/api/request";
import type { PipelineRun } from "@/services/api/pipeline-runs";
import { useUserStore } from "@/stores/use-user-store";

// 批次总状态。与后端 PipelineBatchStatus 对齐。
//   - queued：刚创建，所有 main run 还在排队
//   - running：至少一条 main run 在跑
//   - post_waiting：所有 main run 跑完，等待用户决定是否触发后处理
//   - success / partial / failed：含 post 段在内的所有 run 收敛后的最终态
export type PipelineBatchStatus = "queued" | "running" | "post_waiting" | "success" | "partial" | "failed";

// 批次落库（持久化形态）。命名跟后端 PipelineBatch 完全对齐，前后端共用同一份 JSON。
export type PipelineBatch = {
  id: string;
  userId: string;
  name: string;
  // 主条数（创建时锁定，后续不可改）。1~9。
  totalCount: number;
  status: PipelineBatchStatus;
  // 是否启用后处理段。false 时所有 main 跑完即视为最终态。
  postEnabled: boolean;
  postName: string;
  createdAt: string;
  updatedAt: string;
};

// 批次列表项。在 PipelineBatch 基础上额外带聚合统计，列表页直接渲染进度条用。
export type PipelineBatchListItem = PipelineBatch & {
  mainTotal: number;
  mainSuccess: number;
  mainFailed: number;
  mainRunning: number;
  mainQueued: number;
  mainPaused: number;
  postTotal: number;
  postSuccess: number;
  postFailed: number;
  postRunning: number;
};

export type PipelineBatchListResponse = {
  items: PipelineBatchListItem[];
  total: number;
};

// 批次详情。一次性把批次本体 + main runs + post runs 全部拿回来，避免再发多个请求。
export type PipelineBatchDetail = {
  batch: PipelineBatch;
  mainRuns: PipelineRun[];
  postRuns: PipelineRun[];
};

// 自由配置模式创建批次的 payload：用户在 UI 上逐条挑 seed + pipeline。
//   - items 长度 1~9，对应 totalCount
//   - post.sources 长度 1~6；itemIndex 必须落在 [0, items.length-1]，stepIndex = -1 表示 seed
//   - post.agentIds 长度 1~10，需去重
export type CreateBatchFreePayload = {
  name?: string;
  items: { seedKey: string; pipelineId: string; name?: string }[];
  post?: {
    name?: string;
    sources: { itemIndex: number; stepIndex: number }[];
    agentIds: string[];
  };
};

// 从批次模板创建：templateId 指向已保存的 pipeline_batch_templates 行，
// seedKeys 长度必须等于该模板的 itemCount，按序对应模板里第 i 条主条。
export type CreateBatchFromTemplatePayload = {
  templateId: string;
  seedKeys: string[];
  name?: string;
};

// 用户在 post_waiting 时的决策动作：
//   - "continue"：继续跑后处理段
//   - "skip"：跳过后处理，直接收敛批次为最终态
export type DecidePostAction = "continue" | "skip";

// 重新校验后处理输入时，缺失/不可用的某一项的描述。
//   - runId / stepIndex：定位到哪条主条的哪一步
//   - reason：后端拼好的中文友好描述（譬如「主条 #2 第 3 步还在跑」「主条 #1 第 2 步生成失败」）
export type RecheckPostMissingItem = {
  runId: string;
  stepIndex: number;
  reason: string;
};

// recheck-post 接口响应：missing 缺省表示全部 OK，可以继续；
// 若 missing 非空，前端应阻止用户点「继续后处理」并展示具体原因。
export type RecheckPostResponse = {
  batch: PipelineBatch;
  missing?: RecheckPostMissingItem[];
};

export async function fetchMyPipelineBatches(token: string) {
  return apiGet<PipelineBatchListResponse>("/api/pipeline-batches/me", undefined, token);
}

export async function fetchMyPipelineBatch(token: string, id: string) {
  return apiGet<PipelineBatchDetail>(`/api/pipeline-batches/me/${encodeURIComponent(id)}`, undefined, token);
}

// 自由配置创建：body 不带 templateId，后端按 items 字段判定走自由模式。
export async function createMyPipelineBatchFree(token: string, payload: CreateBatchFreePayload) {
  return apiPost<PipelineBatchDetail>("/api/pipeline-batches/me", payload, token);
}

// 从模板创建：body 带 templateId，后端按是否存在 templateId 判定走模板模式。
export async function createMyPipelineBatchFromTemplate(token: string, payload: CreateBatchFromTemplatePayload) {
  return apiPost<PipelineBatchDetail>("/api/pipeline-batches/me", payload, token);
}

export async function deleteMyPipelineBatch(token: string, id: string) {
  return apiDelete<boolean>(`/api/pipeline-batches/me/${encodeURIComponent(id)}`, token);
}

// 用户在 post_waiting 状态点「继续后处理」或「跳过」时调用。
export async function decideMyPipelineBatchPost(token: string, id: string, action: DecidePostAction) {
  return apiPost<PipelineBatchDetail>(
    `/api/pipeline-batches/me/${encodeURIComponent(id)}/decide-post`,
    { action },
    token,
  );
}

// 在 post_waiting 状态，用户点击「继续后处理」前再校验一次输入是否齐全（可能用户改过主条）。
export async function recheckMyPipelineBatchPost(token: string, id: string) {
  return apiPost<RecheckPostResponse>(
    `/api/pipeline-batches/me/${encodeURIComponent(id)}/recheck-post`,
    {},
    token,
  );
}

// 触发浏览器下载该批次的 zip 产物包（包含所有 main + post run 的产物）。
// 接口不走 envelope，直接拿 attachment 流；用 fetch + blob → ObjectURL → <a download> 模拟点击。
// 同时显式带 Authorization（这接口需要鉴权，不走公开图片路径）。
export async function downloadPipelineBatchZip(id: string, fallbackName?: string) {
  const token = useUserStore.getState().token;
  const response = await fetch(`/api/pipeline-batches/me/${encodeURIComponent(id)}/zip`, {
    method: "GET",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fallbackName?.endsWith(".zip") ? fallbackName : `${fallbackName || `pipeline-batch-${id}`}.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 让浏览器读完再回收
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
