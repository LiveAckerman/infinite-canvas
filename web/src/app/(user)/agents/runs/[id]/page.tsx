"use client";

import { ArrowLeft, ChevronRight, Download, Loader2, Pencil, Play, RotateCw, Sparkles, Trash2, Upload, X } from "lucide-react";
import { App, Button, Image, Input, Tag, Tooltip, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { formatDuration } from "@/lib/image-utils";
import { useImageUploader } from "@/lib/use-image-uploader";
import { imageUrl } from "@/services/image-storage";
import { saveMyAsset } from "@/services/api/my-assets";
import { fetchMyAgents, type Agent } from "@/services/api/agents";
import {
  collectRunProductKeys,
  deleteMyPipelineRun,
  downloadPipelineRunZip,
  downloadSingleImage,
  fetchMyPipelineRun,
  saveMyPipelineRun,
  type PipelineRun,
  type PipelineRunListResponse,
  type PipelineRunStep,
} from "@/services/api/pipeline-runs";
import { fetchMyPipelineBatch } from "@/services/api/pipeline-batches";
import { useUserStore } from "@/stores/use-user-store";

import { AgentAvatar } from "../../components/agent-avatar";
import { RUNS_QUERY_KEY, resolvePostSourceKeys } from "../../hooks/use-pipeline-run-manager";
import { usePipelineRunManagerCtx } from "../../components/pipeline-run-manager-context";

const AGENTS_QUERY_KEY = ["my-agents"] as const;
const BATCHES_QUERY_KEY = ["my-pipeline-batches"] as const;

export default function PipelineRunDetailPage() {
  const params = useParams();
  const rawId = params?.id;
  const runId = typeof rawId === "string" ? rawId : Array.isArray(rawId) ? rawId[0] : "";
  if (!runId) return <div className="p-6 text-sm text-stone-500">执行流程 ID 缺失</div>;
  return <PipelineRunDetail runId={runId} />;
}

function PipelineRunDetail({ runId }: { runId: string }) {
  const { message, modal } = App.useApp();
  const router = useRouter();
  const queryClient = useQueryClient();
  const token = useUserStore((state) => state.token);
  const manager = usePipelineRunManagerCtx();

  const runQuery = useQuery({
    queryKey: [...RUNS_QUERY_KEY, runId],
    queryFn: () => fetchMyPipelineRun(token, runId),
    enabled: Boolean(token && runId),
    // run 状态实时变化时 polling；其它时候不刷
    refetchInterval: (query) => {
      const data = query.state.data as PipelineRun | undefined;
      return data && (data.status === "queued" || data.status === "running") ? 2000 : false;
    },
  });
  const agentsQuery = useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: () => fetchMyAgents(token),
    enabled: Boolean(token),
  });
  const agents = agentsQuery.data?.items || [];
  const run = runQuery.data;

  // 这条 run 属于批次时，返回 / 删除后应回到批次详情页，而不是一律退回 /agents 列表。
  const backTarget = run?.batchId ? `/agents/batches/${run.batchId}` : "/agents";

  // 后处理（post）run 没有 seedKey，输入来自 sourceRefs —— 指向同批次各主条的某步产物。
  // 详情页只拉了自己这一条 run，解析 sourceRefs 需要同批次的 main runs，所以这里按需再拉一次批次详情。
  const isPostRun = run?.kind === "post";
  const batchQuery = useQuery({
    queryKey: [...BATCHES_QUERY_KEY, run?.batchId],
    queryFn: () => fetchMyPipelineBatch(token, run!.batchId),
    enabled: Boolean(token && isPostRun && run?.batchId),
  });
  // post run 的数据源缩略图（解析失败 / 主条未完成时为空数组）。
  const postSourceKeys = useMemo(() => {
    if (!run || !isPostRun) return [];
    return resolvePostSourceKeys(run.sourceRefs || [], batchQuery.data?.mainRuns || []);
  }, [run, isPostRun, batchQuery.data]);

  // 直接深链进 post run 详情时，list cache 里没有同批次的 main runs，
  // 解析数据源 / 在本页「重做」这一步都需要它们。把拉到的批次主条合并进 list cache。
  // 只并 mainRuns，不动 postRuns，避免覆盖本页对当前 post run 的乐观编辑。
  useEffect(() => {
    const mains = batchQuery.data?.mainRuns;
    if (!mains || mains.length === 0) return;
    queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
      if (!old) return { items: mains, total: mains.length };
      const map = new Map(old.items.map((r) => [r.id, r]));
      for (const r of mains) map.set(r.id, r);
      const items = Array.from(map.values());
      return { ...old, items, total: items.length };
    });
  }, [batchQuery.data, queryClient]);

  const [downloading, setDownloading] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => deleteMyPipelineRun(token, runId),
    onSuccess: () => router.push(backTarget),
    onError: (error) => message.error(error instanceof Error ? error.message : "删除失败"),
  });

  // 写回某条修改（单步附加说明、手动覆盖、清覆盖等）。
  // 这里直接 PUT 整条 run，调用方传 patcher 函数。
  //
  // 两个关键点：
  //   1. patcher(run) 里的 run 不从外层闭包拿（renderer 时的快照、会被快速连续输入打回去），
  //      改成从 queryClient 实时拉最新；
  //   2. 乐观更新 + 同时刷 detail / list 两份 cache，让 runner（usePipelineRunManager 读 list cache）
  //      也能拿到用户最新编辑的 extraNote / manualOverrideKey / agentId 等字段。
  const persistRunMutation = useMutation({
    mutationFn: (next: PipelineRun) => saveMyPipelineRun(token, next),
    onError: (error) => message.error(error instanceof Error ? error.message : "保存失败"),
    // 不在 onSuccess 里 setQueryData：避免在用户连续打字的过程中，
    // 服务器返回的旧 snapshot 把用户刚敲的字符清回去（PUT 之间的 race）。
    // 乐观更新已经把最新值写进 cache 了。
  });

  const patchRun = (patcher: (run: PipelineRun) => PipelineRun) => {
    // 从缓存拿最新；如果用户连点 / 连改时外层闭包的 run 还停在某次旧渲染上，
    // 这里始终用最新的，避免覆盖中间状态。
    const latest = queryClient.getQueryData<PipelineRun>([...RUNS_QUERY_KEY, runId]) || run;
    if (!latest) return;
    const next = patcher(latest);
    // 乐观写两份 cache：detail（自己页面）+ list（runner 读取这里）
    queryClient.setQueryData([...RUNS_QUERY_KEY, runId], next);
    queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
      if (!old) return old;
      return { ...old, items: old.items.map((item) => (item.id === next.id ? next : item)) };
    });
    persistRunMutation.mutate(next);
  };

  const runSummary = useMemo(() => {
    if (!run) return null;
    const success = run.steps.filter((step) => step.status === "success").length;
    const failed = run.steps.filter((step) => step.status === "failed").length;
    const idle = run.steps.filter((step) => step.status === "idle").length;
    const running = run.steps.filter((step) => step.status === "running").length;
    return { success, failed, idle, running, total: run.steps.length };
  }, [run]);

  const handleDownload = async () => {
    if (!run) return;
    setDownloading(true);
    try {
      const name = `${run.pipelineName || "pipeline-run"}-${run.id.slice(-6)}`;
      const products = collectRunProductKeys(run);
      if (products.length === 1) {
        await downloadSingleImage(products[0], name);
      } else {
        await downloadPipelineRunZip(run.id, name);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "下载失败");
    } finally {
      setDownloading(false);
    }
  };

  const handleDelete = () => {
    if (!run) return;
    modal.confirm({
      title: "删除执行流程",
      content: `确定删除「${run.pipelineName}」吗？删除后无法恢复，关联的图片资源（原图、各步产物）也会一并删除（仍被别处引用的，比如已加入素材库的，会保留）。`,
      okText: "删除",
      okButtonProps: { danger: true, loading: deleteMutation.isPending },
      cancelText: "取消",
      onOk: () => deleteMutation.mutate(),
    });
  };

  // 「全部重跑」：把所有 step 改为 idle 并把 run.status 设为 queued → RunManager 会接管。
  // 走 patchRun 让 detail + list 缓存同步乐观更新，UI 立即反映。
  const handleRestartAll = () => {
    if (!run) return;
    modal.confirm({
      title: "全部重跑这条流水线？",
      content: "所有步骤会重置为「未运行」，按顺序从头开始。原产物图本身保留在图床里。",
      okText: "全部重跑",
      cancelText: "取消",
      onOk: () => {
        patchRun((current) => ({
          ...current,
          status: "queued",
          steps: current.steps.map((step) => ({
            ...step,
            status: "idle",
            outputKey: undefined,
            errorMessage: undefined,
            durationMs: undefined,
            lastRunSnapshot: undefined,
          })),
        }));
      },
    });
  };

  // 「从第 N 步续跑」：保留 step 0..N-1 的产物，N 之后全部重置为 idle，标记 queued
  const handleContinueFromStep = (index: number) => {
    if (!run) return;
    patchRun((current) => ({
      ...current,
      status: "queued",
      steps: current.steps.map((step, idx) => idx < index ? step : {
        ...step,
        status: "idle",
        outputKey: undefined,
        errorMessage: undefined,
        durationMs: undefined,
        lastRunSnapshot: undefined,
      }),
    }));
  };

  if (runQuery.isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-stone-500">加载中…</div>;
  }
  if (runQuery.error || !run) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-stone-500">
        <p>{runQuery.error instanceof Error ? runQuery.error.message : "执行流程不存在"}</p>
        <Button onClick={() => router.push(backTarget)}>返回列表</Button>
      </div>
    );
  }

  const statusPill = (() => {
    switch (run.status) {
      case "queued": return <Tag className="m-0">排队中</Tag>;
      case "running": return <Tag color="blue" className="m-0">运行中</Tag>;
      case "paused": return <Tag color="gold" className="m-0">已暂停</Tag>;
      case "success": return <Tag color="green" className="m-0">全部完成</Tag>;
      case "partial": return <Tag color="orange" className="m-0">部分完成</Tag>;
      case "failed": return <Tag color="red" className="m-0">失败</Tag>;
      default: return null;
    }
  })();

  const isRunning = run.status === "running" || run.status === "queued";

  return (
    <main className="thin-scrollbar mx-auto h-full w-full max-w-[1600px] overflow-y-auto p-4 lg:p-6">
      {/* 顶栏 */}
      <header className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 bg-card p-3 shadow-sm dark:border-stone-800">
        <Button icon={<ArrowLeft className="size-4" />} onClick={() => router.push(backTarget)}>返回</Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Typography.Title level={4} className="!mb-0 !text-base sm:!text-lg">{run.pipelineName || "未命名流水线"}</Typography.Title>
            {statusPill}
            {runSummary ? (
              <span className="text-xs text-stone-500 dark:text-stone-400">
                {runSummary.success}/{runSummary.total} 成功
                {runSummary.failed > 0 ? ` · ${runSummary.failed} 失败` : ""}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button icon={<Play className="size-4" />} disabled={isRunning} onClick={handleRestartAll}>全部重跑</Button>
          <Button icon={<Download className="size-4" />} loading={downloading} onClick={() => void handleDownload()} disabled={!run.steps.some((step) => step.outputKey)}>下载所有产物 (zip)</Button>
          <Button danger icon={<Trash2 className="size-4" />} onClick={handleDelete}>删除</Button>
        </div>
      </header>

      {/* 原图 / 数据源 + 步骤链 */}
      <div className="hover-scrollbar flex items-start gap-3 overflow-x-auto pb-4">
        {isPostRun ? (
          <PostSourcePanel keys={postSourceKeys} loading={batchQuery.isLoading} />
        ) : (
          <SeedThumb seedKey={run.seedKey} />
        )}
        {run.steps.map((step, index) => (
          <span key={step.stepId} className="flex shrink-0 items-stretch gap-3">
            <ChevronRight className="mt-12 size-5 shrink-0 text-stone-400" />
            <RunStepCard
              index={index}
              step={step}
              run={run}
              agents={agents}
              postSourceKeys={isPostRun && index === 0 ? postSourceKeys : undefined}
              disabled={isRunning}
              onChangeExtraNote={(next) => patchRun((current) => ({
                ...current,
                steps: current.steps.map((item, idx) => (idx === index ? { ...item, extraNote: next } : item)),
              }))}
              onChangeAgent={(agentId) => {
                const agent = agents.find((a) => a.id === agentId);
                patchRun((current) => ({
                  ...current,
                  steps: current.steps.map((item, idx) => (idx === index ? { ...item, agentId, agentName: agent?.name || item.agentName, avatarUrl: agent?.avatarUrl || item.avatarUrl, lastRunSnapshot: undefined } : item)),
                }));
              }}
              onUploadOverride={(key, _url) => patchRun((current) => ({
                ...current,
                steps: current.steps.map((item, idx) => (idx === index ? { ...item, manualOverrideKey: key } : item)),
              }))}
              onClearOverride={() => patchRun((current) => ({
                ...current,
                steps: current.steps.map((item, idx) => (idx === index ? { ...item, manualOverrideKey: undefined } : item)),
              }))}
              onRunSingle={() => void manager.runSingleStep(run.id, index)}
              onContinueFrom={() => void handleContinueFromStep(index)}
            />
          </span>
        ))}
      </div>
    </main>
  );
}

function SeedThumb({ seedKey }: { seedKey: string }) {
  return (
    <div className="flex w-[180px] shrink-0 flex-col gap-2 rounded-lg border border-stone-200 bg-card p-3 dark:border-stone-800">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-stone-500 dark:text-stone-400">原图</span>
        <span className="text-[11px] text-stone-400">seed</span>
      </div>
      {seedKey ? (
        <Image src={imageUrl(seedKey)} alt="原图" className="!w-full rounded-md object-contain" preview={{ mask: "查看大图" }} />
      ) : (
        <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-stone-300 text-xs text-stone-400 dark:border-stone-700">无</div>
      )}
    </div>
  );
}

// 后处理 run 的「数据源」面板：取代 SeedThumb。post run 没有单张 seed，输入是同批次多条主条产物，
// 这里把解析出来的 N 张数据源缩略图竖排列出来（可点击放大、左右切换）。
function PostSourcePanel({ keys, loading }: { keys: string[]; loading: boolean }) {
  return (
    <div className="flex w-[180px] shrink-0 flex-col gap-2 rounded-lg border border-stone-200 bg-card p-3 dark:border-stone-800">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-stone-500 dark:text-stone-400">数据源</span>
        <span className="text-[11px] text-stone-400">{keys.length} 张</span>
      </div>
      {loading ? (
        <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-stone-300 text-xs text-stone-400 dark:border-stone-700">加载中…</div>
      ) : keys.length ? (
        <Image.PreviewGroup>
          <div className="thin-scrollbar grid max-h-[360px] grid-cols-2 gap-2 overflow-y-auto">
            {keys.map((key, idx) => (
              <Image
                key={`${key}-${idx}`}
                src={imageUrl(key)}
                alt={`数据源 ${idx + 1}`}
                className="!aspect-square !w-full rounded-md object-cover"
                rootClassName="!block cursor-zoom-in"
                preview={{ mask: false }}
              />
            ))}
          </div>
        </Image.PreviewGroup>
      ) : (
        <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-stone-300 px-2 text-center text-[11px] text-amber-600 dark:border-stone-700 dark:text-amber-400">
          暂未解析到可用数据源（主条未完成 / 角色已删除）
        </div>
      )}
    </div>
  );
}

type RunStepCardProps = {
  index: number;
  step: PipelineRunStep;
  run: PipelineRun;
  agents: Agent[];
  // 仅 post run 的第一步：解析出来的多张数据源 storageKey。传了就用「数据源」展示，不走单图 inputKey 那套。
  postSourceKeys?: string[];
  disabled?: boolean;
  onChangeExtraNote: (next: string) => void;
  onChangeAgent: (agentId: string) => void;
  onUploadOverride: (key: string, url: string) => void;
  onClearOverride: () => void;
  onRunSingle: () => void;
  onContinueFrom: () => void;
};

// run 详情页里每步的卡片。比模板里复杂得多：要展示输入图 / 输出图 / 状态 / 错误 / 重做按钮 / 替换输入等。
// 不复用 PipelineStepCard（那个是为 PipelineMode 的本地 StepRuntime 设计的，类型不一致）；这里跟 PipelineRunStep 直接对接。
function RunStepCard({ index, step, run, agents, postSourceKeys, disabled, onChangeExtraNote, onChangeAgent, onUploadOverride, onClearOverride, onRunSingle, onContinueFrom }: RunStepCardProps) {
  const { message } = App.useApp();
  const token = useUserStore((state) => state.token);
  const uploadWithToast = useImageUploader();
  const overrideInputRef = useRef<HTMLInputElement>(null);

  // post run 第一步：输入是多张数据源（来自同批次主条产物），不走 seed / 手动覆盖那套。
  const isPostSource = Array.isArray(postSourceKeys);

  // 计算当前输入 key（前端独立算一份，跟后端 runner 一致）
  const inputKey = step.manualOverrideKey
    || (index === 0 ? run.seedKey : (run.steps[index - 1]?.status === "success" ? run.steps[index - 1].outputKey || "" : ""));
  const inputSource: "manual" | "upstream" | "seed" = step.manualOverrideKey ? "manual" : index === 0 ? "seed" : "upstream";

  // 「是否有可用输入」用来 gate 运行按钮：post run 看数据源是否解析到，普通步看单张 inputKey。
  // 注意：必须放在 inputKey 声明之后，否则 TS 报 used-before-declaration。
  const hasInput = isPostSource ? postSourceKeys!.length > 0 : Boolean(inputKey);

  const lastSnap = step.lastRunSnapshot;
  const lastWasIterate = lastSnap?.inputSource === "iterate";
  // stale 判定：
  //   - 「上次是迭代」→ 只看附加说明是否又变了；上游怎么变都和这一步无关
  //   - 「上次是 upstream」→ 输入 key 或附加说明任一变了都算 stale
  const stale = step.status === "success"
    && lastSnap
    && (
      lastWasIterate
        ? lastSnap.extraNote !== step.extraNote
        : (lastSnap.inputKey !== inputKey || lastSnap.extraNote !== step.extraNote)
    );

  // 预测下一次点击 onRunSingle 会走「迭代」还是「常规重做」，用来决定按钮文案 + tooltip。
  // 规则跟 use-pipeline-run-manager.ts 里的 iterateOnOwnOutput 保持一致。
  const extraNoteChangedSinceSnap = Boolean(lastSnap) && lastSnap!.extraNote !== step.extraNote;
  const willIterate = Boolean(step.outputKey)
    && step.extraNote.trim() !== ""
    && extraNoteChangedSinceSnap
    && Boolean(lastSnap)
    && (lastWasIterate || lastSnap!.inputKey === inputKey);

  const agent = agents.find((a) => a.id === step.agentId);
  const agentExists = Boolean(agent);
  const agentOptions = agents.map((a) => ({ label: a.name, value: a.id }));

  const statusPill = (() => {
    if (!agentExists) return <Tag color="red" className="m-0">角色已删除</Tag>;
    if (step.status === "running") return <Tag color="blue" className="m-0">运行中</Tag>;
    if (step.status === "failed") return <Tag color="red" className="m-0">失败</Tag>;
    if (step.status === "success" && stale) {
      return willIterate
        ? <Tag color="purple" className="m-0">将基于产物迭代</Tag>
        : <Tag color="gold" className="m-0">上游已变更</Tag>;
    }
    if (step.status === "success") return <Tag color="green" className="m-0">已完成</Tag>;
    return <Tag className="m-0">未运行</Tag>;
  })();

  const runLabel = step.status === "success"
    ? (stale ? (willIterate ? "基于产物微调" : "用新输入重做") : "重做")
    : step.status === "failed" ? "重试" : "运行";
  const runIcon = step.status === "failed"
    ? <RotateCw className="size-3.5" />
    : willIterate
      ? <Sparkles className="size-3.5" />
      : <Play className="size-3.5" />;
  const runTooltip = willIterate
    ? "把这一步刚才生成的产物当成参考图，再叠加上你刚填的附加说明（如「将衣服改成红色」）重新调用模型 —— 不会从上游/原图重头跑，适合在已有结果上做小调整。"
    : step.status === "success" && stale
      ? "用最新的上游产物 / 替换的原图 + 角色提示词重新跑一次（重头开始）。"
      : step.status === "success"
        ? "用一样的输入和角色提示词再跑一次（结果可能略有不同）。"
        : step.status === "failed"
          ? "用上次的输入再重试一次。"
          : "运行这一步。";

  const handleOverrideFile = async (file?: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      message.error("请选择图片文件");
      return;
    }
    try {
      const stored = await uploadWithToast(file, { label: "本步输入图" });
      onUploadOverride(stored.storageKey, stored.url);
    } catch {
      // uploader 已弹错误
    }
  };

  const handleSaveAsset = async () => {
    if (!step.outputKey || !token) return;
    try {
      await saveMyAsset(token, {
        title: `${step.agentName || "步骤"} 产物`,
        type: "image",
        coverUrl: imageUrl(step.outputKey),
        tags: [],
        category: "流水线",
        description: step.extraNote || "",
        url: imageUrl(step.outputKey),
      });
      message.success("已加入我的素材");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "保存失败");
    }
  };

  return (
    <div className="flex w-[300px] shrink-0 flex-col gap-2 rounded-lg border border-stone-200 bg-card p-3 shadow-sm dark:border-stone-800">
      <div className="flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-stone-100 text-xs font-semibold text-stone-700 dark:bg-stone-800 dark:text-stone-200">{index + 1}</span>
        <AgentAvatar name={step.agentName || "?"} avatarUrl={step.avatarUrl} size={28} />
        <select
          value={step.agentId}
          onChange={(event) => onChangeAgent(event.target.value)}
          disabled={disabled}
          className="min-w-0 flex-1 truncate rounded border-0 bg-transparent text-sm font-medium focus:outline-none disabled:opacity-60"
        >
          {agentOptions.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          {!agentExists ? <option value={step.agentId}>{step.agentName || "已删除"}</option> : null}
        </select>
      </div>
      <div className="flex justify-end">{statusPill}</div>

      {/* 输入：post run 第一步走「数据源 N 张」，普通步走单张输入图 + 替换输入 */}
      {isPostSource ? (
        <div className="rounded-md border border-stone-200 p-2 dark:border-stone-800">
          <div className="mb-1.5 text-[11px] text-stone-500 dark:text-stone-400">数据源 {postSourceKeys!.length} 张（来自主条产物）</div>
          {postSourceKeys!.length ? (
            <Image.PreviewGroup>
              <div className="flex flex-wrap gap-1">
                {postSourceKeys!.map((key, idx) => (
                  <Image
                    key={`${key}-${idx}`}
                    src={imageUrl(key)}
                    alt={`数据源 ${idx + 1}`}
                    className="!size-12 rounded border border-stone-200 object-cover dark:border-stone-800"
                    rootClassName="!block !size-12 shrink-0 cursor-zoom-in"
                    preview={{ mask: false }}
                  />
                ))}
              </div>
            </Image.PreviewGroup>
          ) : (
            <div className="py-2 text-[11px] text-amber-600 dark:text-amber-400">暂未解析到可用数据源（主条未完成 / 角色已删除）</div>
          )}
        </div>
      ) : (
        <div className="flex gap-2 rounded-md border border-stone-200 p-2 dark:border-stone-800">
          <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded bg-stone-50 dark:bg-stone-900">
            {inputKey ? (
              <img src={imageUrl(inputKey)} alt="本步输入" className="size-full object-cover" />
            ) : (
              <span className="text-[10px] text-stone-400">无</span>
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col justify-between">
            <div className="flex items-center gap-1 text-[11px] text-stone-500 dark:text-stone-400">
              {inputSource === "manual" ? <Pencil className="size-3 text-amber-500" /> : null}
              <span>{inputSource === "manual" ? "手动替换" : inputSource === "seed" ? "来自原图" : `来自步骤 ${index}`}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              <Button size="small" disabled={disabled} icon={<Upload className="size-3" />} onClick={() => overrideInputRef.current?.click()}>{step.manualOverrideKey ? "换张图" : "替换输入"}</Button>
              {step.manualOverrideKey ? <Button size="small" type="text" disabled={disabled} onClick={onClearOverride}>用上游</Button> : null}
            </div>
            <input
              ref={overrideInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              tabIndex={-1}
              aria-hidden
              onChange={(event) => {
                void handleOverrideFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
        </div>
      )}

      <Input.TextArea
        value={step.extraNote}
        onChange={(event) => onChangeExtraNote(event.target.value)}
        placeholder="附加说明（可选）—— 拼在角色系统提示词后面"
        rows={2}
        disabled={disabled}
      />

      {/* 输出 */}
      <div className="relative min-h-[120px] overflow-hidden rounded-md bg-stone-50 dark:bg-stone-900">
        {step.status === "running" ? (
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
            <Loader2 className="size-5 animate-spin" />
            <span>正在生成…</span>
          </div>
        ) : step.outputKey ? (
          <Image src={imageUrl(step.outputKey)} alt={`步骤 ${index + 1} 产物`} className="!w-full object-contain" preview={{ mask: "查看大图" }} />
        ) : (
          <div className="flex h-32 items-center justify-center text-xs text-stone-400">未运行 / 无产物</div>
        )}
      </div>

      {step.status === "failed" && step.errorMessage ? (
        <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] leading-4 text-red-600 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          <span className="line-clamp-3">{step.errorMessage}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1">
        <Tooltip title={runTooltip}>
          <Button
            type="primary"
            size="small"
            disabled={disabled || !agentExists || !hasInput}
            icon={runIcon}
            onClick={onRunSingle}
          >
            {runLabel}
          </Button>
        </Tooltip>
        <Button size="small" disabled={disabled} icon={<ChevronRight className="size-3.5" />} onClick={onContinueFrom}>从此处续跑</Button>
        {step.outputKey ? (
          <Button size="small" disabled={disabled} onClick={() => void handleSaveAsset()}>加入素材</Button>
        ) : null}
        {step.durationMs ? <span className="ml-auto text-[10px] leading-6 text-stone-400">{formatDuration(step.durationMs)}</span> : null}
      </div>
    </div>
  );
}
