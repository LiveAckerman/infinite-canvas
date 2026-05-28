"use client";

import { ChevronDown, FolderCog, Play, Plus } from "lucide-react";
import { App, Button, Checkbox, Dropdown, Empty, Tag, type MenuProps } from "antd";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { createId } from "@/lib/id";
import { fetchMyPipelines, saveMyPipeline, deleteMyPipeline, type Pipeline, type PipelineListResponse } from "@/services/api/pipelines";
import {
  createMyPipelineRun,
  deleteMyPipelineRun,
  downloadPipelineRunZip,
  fetchMyPipelineRuns,
  saveMyPipelineRun,
  type PipelineRun,
  type PipelineRunListResponse,
} from "@/services/api/pipeline-runs";
import type { Agent } from "@/services/api/agents";
import { useUserStore } from "@/stores/use-user-store";

import { PipelineRunCard } from "./pipeline-run-card";
import { PipelineTemplateManagerModal } from "./pipeline-template-manager-modal";
import { PipelineTemplateModal } from "./pipeline-template-modal";
import { RUNS_QUERY_KEY } from "../hooks/use-pipeline-run-manager";
import { usePipelineRunManagerCtx } from "./pipeline-run-manager-context";
import type { TemplateDraft } from "./pipeline-template-editor";

const PIPELINES_QUERY_KEY = ["my-pipelines"] as const;

type Props = {
  agents: Agent[];
};

// /agents 「流水线模式」Tab 的主组件。整体改成：
//   - 顶部两个 CTA：「管理流水线模板」（次要）+「+ 新增执行流程」（主要）
//   - 中部：执行流程列表（多张 PipelineRunCard）
//   - 三个 Modal：模板管理 / 模板编辑 / 新增执行流程
// 模板编辑器和单 run 详情都不在这页直接渲染，分别走 Modal / 子路由。
export function PipelineMode({ agents }: Props) {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const router = useRouter();
  const token = useUserStore((state) => state.token);

  const pipelinesQuery = useQuery({
    queryKey: PIPELINES_QUERY_KEY,
    queryFn: () => fetchMyPipelines(token),
    enabled: Boolean(token),
  });
  const pipelines = pipelinesQuery.data?.items || [];

  // 列表查询。仅在「列表里至少一个 run 处于 queued/running」时开 polling，省请求。
  const runsQuery = useQuery({
    queryKey: RUNS_QUERY_KEY,
    queryFn: () => fetchMyPipelineRuns(token),
    enabled: Boolean(token),
    refetchInterval: (query) => {
      const data = query.state.data as PipelineRunListResponse | undefined;
      const hasActive = (data?.items || []).some((item) => item.status === "queued" || item.status === "running");
      return hasActive ? 3000 : false;
    },
  });
  // 流水线模式只显示「独立 run」（不属于任何 batch）。
  // 批量任务里生成的 runs 在「批量任务」Tab 里看，混在这里会让列表变得很乱、容易误删。
  const runs = useMemo(() => {
    const all = runsQuery.data?.items || [];
    return all.filter((run) => !run.batchId);
  }, [runsQuery.data]);

  // 用上层 Provider 提供的单例调度器（cap=3）
  usePipelineRunManagerCtx();

  // Modal 开关
  const [managerOpen, setManagerOpen] = useState(false);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Pipeline | null>(null);
  const [downloadingId, setDownloadingId] = useState<string>("");
  // 多选执行：勾中的 run id 集合；只有「待执行」状态（paused + 有 seed）勾中才进 handleStartRuns。
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());

  // ====== 模板 CRUD mutations ======

  const saveTemplateMutation = useMutation({
    mutationFn: (payload: Partial<Pipeline>) => saveMyPipeline(token, payload),
    onSuccess: (saved) => {
      queryClient.setQueryData<PipelineListResponse>(PIPELINES_QUERY_KEY, (old) => {
        if (!old) return { items: [saved], total: 1 };
        const exists = old.items.some((item) => item.id === saved.id);
        if (exists) return { ...old, items: old.items.map((item) => (item.id === saved.id ? saved : item)) };
        return { items: [saved, ...old.items], total: old.total + 1 };
      });
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "保存失败");
    },
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: (id: string) => deleteMyPipeline(token, id),
    onSuccess: (_, id) => {
      queryClient.setQueryData<PipelineListResponse>(PIPELINES_QUERY_KEY, (old) => {
        if (!old) return old;
        return { ...old, items: old.items.filter((item) => item.id !== id), total: Math.max(0, old.total - 1) };
      });
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "删除失败");
    },
  });

  const handleTemplateSubmit = async (draft: TemplateDraft) => {
    try {
      await saveTemplateMutation.mutateAsync({
        id: editingTemplate?.id,
        name: draft.name,
        description: draft.description,
        steps: draft.steps.map((step) => ({
          stepId: step.stepId,
          agentId: step.agentId,
          extraNote: step.extraNote,
        })),
      });
      setTemplateModalOpen(false);
      setEditingTemplate(null);
      message.success(editingTemplate ? "已保存" : "已新建流水线");
    } catch {
      // mutation onError 已弹错误
    }
  };

  const handleTemplateDuplicate = async (pipeline: Pipeline) => {
    try {
      await saveTemplateMutation.mutateAsync({
        name: `${pipeline.name} 副本`,
        description: pipeline.description,
        steps: pipeline.steps.map((step) => ({ ...step, stepId: createId() })),
      });
      message.success("已复制一份");
    } catch {
      // mutation onError 已弹错误
    }
  };

  // ====== Run mutations ======

  const createRunMutation = useMutation({
    mutationFn: (payload: { pipelineId: string; seedKey: string }) => createMyPipelineRun(token, payload),
    onSuccess: (saved) => {
      queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
        if (!old) return { items: [saved], total: 1 };
        return { items: [saved, ...old.items], total: old.total + 1 };
      });
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "新增失败");
    },
  });

  const deleteRunMutation = useMutation({
    mutationFn: (id: string) => deleteMyPipelineRun(token, id),
    onSuccess: (_, id) => {
      queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
        if (!old) return old;
        return { ...old, items: old.items.filter((item) => item.id !== id), total: Math.max(0, old.total - 1) };
      });
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "删除失败");
    },
  });

  // 直接基于一个模板新建一条空 seed 的执行流程，落到列表里。
  // 用户上传原图后由 PipelineRunCard 内部 PUT 把 seedKey 写入 + status 转为 queued 触发调度。
  const handleCreateRunFromTemplate = async (pipelineId: string) => {
    try {
      await createRunMutation.mutateAsync({ pipelineId, seedKey: "" });
      message.success("已添加，请上传原图");
    } catch {
      // mutation onError 已弹错误
    }
  };

  // 「复制」执行流程：用同一个 pipelineId 起一条新的空 seed run。
  // 等同于「再用这个模板跑一条」，跟原 run 的 seed / 产物 / 状态完全无关。
  const handleDuplicateRun = async (run: PipelineRun) => {
    try {
      await createRunMutation.mutateAsync({ pipelineId: run.pipelineId, seedKey: "" });
      message.success("已复制模板，请上传原图");
    } catch {
      // mutation onError 已弹错误
    }
  };

  // 上传完原图后：仅把 seedKey 写回，status 保持 paused（不再自动调度），
  // 由用户在卡片上点「▶ 执行」或工具栏「全部执行」/「执行选中」才转 queued。
  const handleSeedUploaded = async (run: PipelineRun, seedKey: string) => {
    try {
      await saveMyPipelineRun(token, { ...run, seedKey });
      queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
        if (!old) return old;
        return { ...old, items: old.items.map((item) => (item.id === run.id ? { ...item, seedKey } : item)) };
      });
    } catch (error) {
      message.error(error instanceof Error ? error.message : "保存原图失败");
    }
  };

  // 构造一份「从头跑」版本：所有步骤重置为 idle，清掉 output / error / lastRunSnapshot，
  // 整体 status = queued。给单条「执行 / 重新执行」和批量启动共用。
  // 必须重置 step.status，否则调度器 runRun 看到 `step.status === "success"` 会跳过整步，
  // 导致「重新执行」无效。outputKey 清空是为了让 UI 立刻显示「等待重跑」而不是仍展示旧产物。
  // 注：旧 outputKey 对应的图床文件不删，复制 run / 加入素材的图都不受影响。
  const buildResetRun = (run: PipelineRun): PipelineRun => ({
    ...run,
    status: "queued",
    steps: run.steps.map((step) => ({
      ...step,
      status: "idle",
      outputKey: undefined,
      errorMessage: undefined,
      durationMs: undefined,
      lastRunSnapshot: undefined,
    })),
  });

  // 把指定 run 推到 queued 让调度器接管。
  // paused → queued = 首次执行；success / partial / failed → queued = 重新执行（重置所有步骤）。
  const handleStartRun = async (run: PipelineRun) => {
    if (!run.seedKey) {
      message.warning("请先上传原图");
      return;
    }
    const next = buildResetRun(run);
    try {
      await saveMyPipelineRun(token, next);
      queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
        if (!old) return old;
        return { ...old, items: old.items.map((item) => (item.id === run.id ? next : item)) };
      });
    } catch (error) {
      message.error(error instanceof Error ? error.message : "启动失败");
    }
  };

  // 批量启动：对一组 run 串行 PUT 重置 + queued。
  // 串行是为了避免一下子打过多并发 PUT；调度器最终用 cap=3 并发跑。
  const handleStartRuns = async (targets: PipelineRun[]) => {
    const eligible = targets.filter(isRunEligible);
    if (eligible.length === 0) {
      message.info("没有可执行的流程");
      return;
    }
    const resetMap = new Map<string, PipelineRun>();
    let started = 0;
    for (const run of eligible) {
      const next = buildResetRun(run);
      try {
        await saveMyPipelineRun(token, next);
        resetMap.set(run.id, next);
        started += 1;
      } catch {
        // 单个失败不阻断其余
      }
    }
    if (started > 0) {
      queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
        if (!old) return old;
        return { ...old, items: old.items.map((item) => resetMap.get(item.id) || item) };
      });
      message.success(`已启动 ${started} 条流程`);
    } else {
      message.error("启动失败");
    }
  };

  // 顶部「+ 新增执行流程」下拉菜单 —— 列出所有模板，点击即直接创建一条空 seed run，不弹窗。
  const createMenuItems: MenuProps["items"] = pipelines.length === 0
    ? [{ key: "empty", label: <span className="text-stone-400">还没有模板，请先「管理流水线模板」新建</span>, disabled: true }]
    : pipelines.map((pipeline) => ({
      key: pipeline.id,
      label: (
        <div className="flex max-w-[280px] flex-col">
          <span className="truncate text-sm font-medium">{pipeline.name}</span>
          <span className="text-[11px] text-stone-500 dark:text-stone-400">{pipeline.steps.length} 步</span>
        </div>
      ),
      onClick: () => void handleCreateRunFromTemplate(pipeline.id),
    }));

  const handleDeleteRun = (run: PipelineRun) => {
    modal.confirm({
      title: "删除执行流程",
      content: `确定删除「${run.pipelineName}」这条执行流程吗？产物图本身不会被删（如果加入了素材库还在）。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => deleteRunMutation.mutate(run.id),
    });
  };

  const handleDownloadZip = async (run: PipelineRun) => {
    setDownloadingId(run.id);
    try {
      await downloadPipelineRunZip(run.id, `${run.pipelineName || "pipeline-run"}-${run.id.slice(-6)}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "下载失败");
    } finally {
      setDownloadingId("");
    }
  };

  // ====== 顶部入口可用性 ======

  const canCreateRun = pipelines.length > 0;
  const canCreateTemplate = agents.length > 0;
  const runStats = useMemo(() => {
    const queued = runs.filter((item) => item.status === "queued").length;
    const running = runs.filter((item) => item.status === "running").length;
    return { queued, running };
  }, [runs]);

  // 哪些 run 可以被「执行 / 重新执行」按钮触发：已上传原图 + 不在跑（不是 queued / running）。
  // 包含 paused（首次执行）/ success / partial / failed（重新执行，会清旧产物从头跑）。
  // 这条规则同时控制：卡片上「执行 / 重新执行」按钮的显示 + 多选 Checkbox 的可选 + 批量工具栏的可用性。
  const eligibleRuns = useMemo(() => runs.filter(isRunEligible), [runs]);
  const eligibleIdSet = useMemo(() => new Set(eligibleRuns.map((item) => item.id)), [eligibleRuns]);
  // 选中的且仍可执行的 id（防止勾完之后被别处刷成 running 仍被纳入选中）
  const selectedEligibleRuns = useMemo(() => eligibleRuns.filter((item) => selectedRunIds.has(item.id)), [eligibleRuns, selectedRunIds]);
  const allEligibleSelected = eligibleRuns.length > 0 && selectedEligibleRuns.length === eligibleRuns.length;
  const someEligibleSelected = selectedEligibleRuns.length > 0 && !allEligibleSelected;

  const toggleSelectAllEligible = (checked: boolean) => {
    setSelectedRunIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        eligibleRuns.forEach((item) => next.add(item.id));
      } else {
        eligibleRuns.forEach((item) => next.delete(item.id));
      }
      return next;
    });
  };

  const toggleSelectRun = (runId: string, checked: boolean) => {
    setSelectedRunIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(runId);
      else next.delete(runId);
      return next;
    });
  };

  const handleClickStartAll = () => void handleStartRuns(eligibleRuns);
  const handleClickStartSelected = () => {
    void handleStartRuns(selectedEligibleRuns).then(() => {
      // 跑起来后清空选中状态，避免一直高亮已经在跑的卡片
      setSelectedRunIds(new Set());
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 顶部工具栏：管理模板 + 新增执行流程 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-card p-3 shadow-sm dark:border-stone-800">
        <Button
          icon={<FolderCog className="size-4" />}
          onClick={() => setManagerOpen(true)}
        >
          管理流水线模板 ({pipelines.length})
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {runStats.running > 0 || runStats.queued > 0 ? (
            <span className="text-xs text-stone-500 dark:text-stone-400">
              当前在跑 {runStats.running}{runStats.queued > 0 ? ` · 排队中 ${runStats.queued}` : ""}
            </span>
          ) : null}
          <Dropdown
            menu={{ items: createMenuItems }}
            trigger={["click"]}
            placement="bottomRight"
            disabled={!canCreateRun}
          >
            <Button
              type="primary"
              icon={<Plus className="size-4" />}
              disabled={!canCreateRun}
              loading={createRunMutation.isPending}
              title={!canCreateRun ? "请先在「管理流水线模板」里新建一条流水线" : "选择一个模板直接添加"}
            >
              新增执行流程
              <ChevronDown className="size-3.5" />
            </Button>
          </Dropdown>
        </div>
      </div>

      {/* 列表区 */}
      {runsQuery.isLoading ? (
        <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-stone-300 text-sm text-stone-500 dark:border-stone-700">加载中…</div>
      ) : runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-stone-300 p-10 text-center dark:border-stone-700">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={(
              <div className="text-sm text-stone-500 dark:text-stone-400">
                还没有任何执行流程<br />
                {canCreateRun
                  ? "点右上「+ 新增执行流程」选一个模板就能添加；添加后在卡片内上传原图开始跑"
                  : canCreateTemplate
                    ? "请先点上方「管理流水线模板」→「新建流水线」"
                    : "请先在左侧「我的角色」新建几个角色，再来编排流水线"}
              </div>
            )}
          />
        </div>
      ) : (
        <>
          {/* 批量操作工具栏：只要列表里有 1 条可执行（含可重新执行）就显示 */}
          {eligibleRuns.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900">
              <Checkbox
                checked={allEligibleSelected}
                indeterminate={someEligibleSelected}
                onChange={(event) => toggleSelectAllEligible(event.target.checked)}
              >
                全选可执行（{eligibleRuns.length}）
              </Checkbox>
              <span className="text-xs text-stone-500 dark:text-stone-400">已选 {selectedEligibleRuns.length} 条</span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button
                  size="small"
                  icon={<Play className="size-3.5" />}
                  disabled={selectedEligibleRuns.length === 0}
                  onClick={handleClickStartSelected}
                >
                  执行选中（{selectedEligibleRuns.length}）
                </Button>
                <Button
                  size="small"
                  type="primary"
                  icon={<Play className="size-3.5" />}
                  onClick={handleClickStartAll}
                >
                  全部执行（{eligibleRuns.length}）
                </Button>
              </div>
              {/* 提示：可执行集合包含已完成 / 失败的 run，启动时会清旧产物从头跑 */}
              <div className="w-full text-[11px] text-stone-500 dark:text-stone-400">
                包含「待执行」「已完成」「失败」的流程；点了会清掉旧产物从第 1 步重新跑。想保留旧结果请改用「复制」。
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-3">
            {runs.map((run) => {
              const eligible = eligibleIdSet.has(run.id);
              return (
                <PipelineRunCard
                  key={run.id}
                  run={run}
                  onOpen={() => router.push(`/agents/runs/${run.id}`)}
                  onDownload={() => void handleDownloadZip(run)}
                  onDelete={() => handleDeleteRun(run)}
                  onDuplicate={() => void handleDuplicateRun(run)}
                  onSeedUploaded={(seedKey) => void handleSeedUploaded(run, seedKey)}
                  onStart={() => void handleStartRun(run)}
                  selected={selectedRunIds.has(run.id)}
                  onSelectedChange={(checked) => toggleSelectRun(run.id, checked)}
                  eligible={eligible}
                  downloading={downloadingId === run.id}
                />
              );
            })}
          </div>
        </>
      )}

      {/* Modals */}
      <PipelineTemplateManagerModal
        open={managerOpen}
        pipelines={pipelines}
        agents={agents}
        loading={pipelinesQuery.isLoading}
        onClose={() => setManagerOpen(false)}
        onNew={() => {
          if (!canCreateTemplate) {
            message.warning("请先到左侧「我的角色」新建几个角色");
            return;
          }
          setEditingTemplate(null);
          setManagerOpen(false);
          setTemplateModalOpen(true);
        }}
        onEdit={(pipeline) => {
          setEditingTemplate(pipeline);
          setManagerOpen(false);
          setTemplateModalOpen(true);
        }}
        onDuplicate={(pipeline) => void handleTemplateDuplicate(pipeline)}
        onDelete={(pipeline) => deleteTemplateMutation.mutate(pipeline.id)}
      />

      <PipelineTemplateModal
        open={templateModalOpen}
        editing={editingTemplate}
        agents={agents}
        submitting={saveTemplateMutation.isPending}
        onSubmit={handleTemplateSubmit}
        onClose={() => {
          setTemplateModalOpen(false);
          setEditingTemplate(null);
        }}
      />

      <Tag className="self-end !text-xs" color="default">提示：单浏览器最多并行 3 条；超出会进排队</Tag>
    </div>
  );
}

// 判定 run 是否可被「执行 / 重新执行」按钮触发。
// 需要有 seed，且不在跑（queued / running 都跳过，避免被重复触发）。
// success / partial / failed / paused 都允许，由调用方负责重置步骤状态。
function isRunEligible(run: PipelineRun): boolean {
  if (!run.seedKey) return false;
  return run.status === "paused" || run.status === "success" || run.status === "partial" || run.status === "failed";
}
