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

// 「批次后处理」单条主条产物的引用。仅 PipelineRun.kind=="post" 时有意义：
// 表示这条 post run 的 seed / 中间输入来自批次内哪条主条 run 的哪一步产物。
//   - stepIndex = -1 → 取那条主条 run 的 seedKey
//   - stepIndex >= 0 → 取那条主条 run 的 steps[stepIndex].outputKey
export type PipelineRunSourceRef = {
  runId: string;
  stepIndex: number;
};

export type PipelineRun = {
  id: string;
  userId: string;
  pipelineId: string;
  pipelineName: string;
  seedKey: string;
  steps: PipelineRunStep[];
  status: PipelineRunStatus;
  // 所属批次 id。空字符串表示这条 run 是独立调用，不属于任何 pipeline_batches 行。
  batchId: string;
  // run 在批次内的角色：
  //   - "main"：批次主条（用户传 seed → 跑模板）
  //   - "post"：批次后处理（以多个 main run 的产物为输入再跑一遍）
  //   - ""：老数据 / 独立 run 兼容值，视同 "main"
  kind: "" | "main" | "post";
  // run 在批次内的展示顺序：main 段从 0 开始递增；post 段从 0 开始递增。独立 run 一律 0。
  position: number;
  // 仅 kind=="post" 有效：这条 post run 用到的主条产物引用列表，顺序与 post 步骤 seed/extra 拼装一致。
  sourceRefs: PipelineRunSourceRef[];
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

// collectRunProductKeys 收集一条 run 的产物 storageKey（每步 outputKey，按步顺序；不含 seed）。
// 用于判断「是否只有一个产物」以决定直接下图还是打 zip。
export function collectRunProductKeys(run: PipelineRun): string[] {
  return run.steps.map((step) => step.outputKey).filter((key): key is string => Boolean(key));
}

// downloadSingleImage 直接下载单张图（走公开的 /api/images/{key}）。
// 用于「执行流程 / 批次只有一个产物」时，不打 zip 直接下原图。
// 文件扩展名按 blob.type 推断（jpeg → jpg，其余 → png）。
export async function downloadSingleImage(storageKey: string, baseName: string) {
  const response = await fetch(`/api/images/${encodeURIComponent(storageKey)}`);
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）`);
  }
  const blob = await response.blob();
  const ext = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
  // 去掉 baseName 里可能带的 .zip / 其它扩展名，统一用图片扩展名
  const stem = baseName.replace(/\.(zip|png|jpe?g|webp)$/i, "") || "image";
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${stem}.${ext}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
