import { apiDelete, apiGet, apiPost, apiPut } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

// 单步落库状态。与后端 PipelineRunStepStatus 对齐。
export type PipelineRunStepStatus = "idle" | "running" | "success" | "failed";

// 单条 run 总状态。queued / paused 是与后端契合的「半完成态」。
export type PipelineRunStatus = "queued" | "running" | "paused" | "success" | "partial" | "failed";

export type PipelineRunStepSnapshot = {
  inputKey: string;
  extraNote: string;
  // 这一次跑用的是哪种输入来源（用于详情页 stale 判断 + 让"再次迭代"还能继续基于本步最新产物）：
  //   - "upstream"（或缺省，老数据兼容）：computeInputKey 算出来的上游产物 / seed / 手动覆盖
  //   - "iterate"：本步自己的旧 outputKey（用户加了附加说明 + 本步已有产物 → 触发迭代微调）
  inputSource?: "upstream" | "iterate";
};

// 单步落库（持久化形态）。命名跟后端 PipelineRunStep 完全对齐，前后端共用同一份 JSON。
export type PipelineRunStep = {
  stepId: string;
  agentId: string;
  agentName: string;
  avatarUrl: string;
  extraNote: string;
  status: PipelineRunStepStatus;
  manualOverrideKey?: string;
  outputKey?: string;
  lastRunSnapshot?: PipelineRunStepSnapshot;
  errorMessage?: string;
  durationMs?: number;
};

export type PipelineRun = {
  id: string;
  userId: string;
  pipelineId: string;
  pipelineName: string;
  seedKey: string;
  steps: PipelineRunStep[];
  status: PipelineRunStatus;
  createdAt: string;
  updatedAt: string;
};

export type PipelineRunListResponse = {
  items: PipelineRun[];
  total: number;
};

export async function fetchMyPipelineRuns(token: string) {
  return apiGet<PipelineRunListResponse>("/api/pipeline-runs/me", undefined, token);
}

export async function fetchMyPipelineRun(token: string, id: string) {
  return apiGet<PipelineRun>(`/api/pipeline-runs/me/${encodeURIComponent(id)}`, undefined, token);
}

export async function createMyPipelineRun(token: string, payload: { pipelineId: string; seedKey: string }) {
  return apiPost<PipelineRun>("/api/pipeline-runs/me", payload, token);
}

export async function saveMyPipelineRun(token: string, run: PipelineRun) {
  return apiPut<PipelineRun>(`/api/pipeline-runs/me/${encodeURIComponent(run.id)}`, run, token);
}

export async function deleteMyPipelineRun(token: string, id: string) {
  return apiDelete<boolean>(`/api/pipeline-runs/me/${encodeURIComponent(id)}`, token);
}

// 触发浏览器下载该 run 的 zip 产物包。
// 接口不走 envelope，直接拿 attachment 流；用 fetch + blob → ObjectURL → <a download> 模拟点击。
// 同时显式带 Authorization（这接口需要鉴权，不走公开图片路径）。
export async function downloadPipelineRunZip(id: string, fallbackName?: string) {
  const token = useUserStore.getState().token;
  const response = await fetch(`/api/pipeline-runs/me/${encodeURIComponent(id)}/zip`, {
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
  link.download = fallbackName?.endsWith(".zip") ? fallbackName : `${fallbackName || `pipeline-run-${id}`}.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 让浏览器读完再回收
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
