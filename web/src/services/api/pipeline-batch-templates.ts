import { apiDelete, apiGet, apiPost } from "@/services/api/request";

// 批次模板里一条主条的定义：指定跑哪条 pipeline，可选给个 UI 名字。
export type PipelineBatchTemplateItem = {
  pipelineId: string;
  name: string;
};

// 批次模板后处理段的输入引用：模板存的是「主条序号 + 步骤序号」这种相对坐标，
// 实际创建批次时再根据真实 run 解析成 PipelineRunSourceRef。
//   - itemIndex：模板内主条序号 0..itemCount-1
//   - stepIndex：-1 表示取那条主条的 seed，0+ 表示取那条主条的第 N 步产物
export type PipelineBatchTemplateSourceRef = {
  itemIndex: number;
  stepIndex: number;
};

// 批次模板后处理段定义。模板里只存"用哪些 agent + 输入怎么拼"，不存具体素材。
export type PipelineBatchTemplatePost = {
  name: string;
  sources: PipelineBatchTemplateSourceRef[];
  agentIds: string[];
};

// 批次模板落库（持久化形态）。命名跟后端 PipelineBatchTemplate 完全对齐，前后端共用同一份 JSON。
export type PipelineBatchTemplate = {
  id: string;
  userId: string;
  name: string;
  description: string;
  // 主条数（创建时锁定，决定 items.length 以及创建批次时 seedKeys 的长度）。
  itemCount: number;
  items: PipelineBatchTemplateItem[];
  // 可选：未配置后处理段则 post 缺省，对应批次的 postEnabled=false。
  post?: PipelineBatchTemplatePost;
  createdAt: string;
  updatedAt: string;
};

export type PipelineBatchTemplateListResponse = {
  items: PipelineBatchTemplate[];
  total: number;
};

export async function fetchMyPipelineBatchTemplates(token: string) {
  return apiGet<PipelineBatchTemplateListResponse>("/api/pipeline-batch-templates/me", undefined, token);
}

// 保存模板：id 为空时新建，非空时按 id 更新。后端按 owner 校验所有权。
export async function saveMyPipelineBatchTemplate(token: string, payload: Partial<PipelineBatchTemplate>) {
  return apiPost<PipelineBatchTemplate>("/api/pipeline-batch-templates/me", payload, token);
}

export async function deleteMyPipelineBatchTemplate(token: string, id: string) {
  return apiDelete<boolean>(`/api/pipeline-batch-templates/me/${encodeURIComponent(id)}`, token);
}
