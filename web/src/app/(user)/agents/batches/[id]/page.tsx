"use client";

import { AlertTriangle, ArrowLeft, Download, Play, RefreshCw, Trash2 } from "lucide-react";
import { App, Button, Progress, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useUserStore } from "@/stores/use-user-store";
import {
  decideMyPipelineBatchPost,
  deleteMyPipelineBatch,
  downloadPipelineBatchZip,
  fetchMyPipelineBatch,
  recheckMyPipelineBatchPost,
  type PipelineBatchDetail,
  type PipelineBatchStatus,
  type RecheckPostMissingItem,
} from "@/services/api/pipeline-batches";
import {
  saveMyPipelineRun,
  type PipelineRun,
  type PipelineRunListResponse,
} from "@/services/api/pipeline-runs";

import { PipelineRunCard } from "../../components/pipeline-run-card";
import { RUNS_QUERY_KEY } from "../../hooks/use-pipeline-run-manager";

const BATCHES_QUERY_KEY = ["my-pipeline-batches"] as const;

export default function PipelineBatchDetailPage() {
  const params = useParams();
  const rawId = params?.id;
  const batchId = typeof rawId === "string" ? rawId : Array.isArray(rawId) ? rawId[0] : "";
  if (!batchId) return <div className="p-6 text-sm text-stone-500">批量任务 ID 缺失</div>;
  return <PipelineBatchDetail batchId={batchId} />;
}

function PipelineBatchDetail({ batchId }: { batchId: string }) {
  const { message, modal } = App.useApp();
  const router = useRouter();
  const queryClient = useQueryClient();
  const token = useUserStore((state) => state.token);

  // missing 列表：mount 时如果是 post_waiting 自动拉一次 recheck-post；用户后续重新检查 / 决定时刷新
  const [missing, setMissing] = useState<RecheckPostMissingItem[]>([]);
  // 「我先去补救」=> 用户暂时把决策卡隐藏；只能等用户主动点旁边的「重新检查 sources」再次显示
  const [decisionCardHidden, setDecisionCardHidden] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const batchQuery = useQuery({
    queryKey: [...BATCHES_QUERY_KEY, batchId],
    queryFn: () => fetchMyPipelineBatch(token, batchId),
    enabled: Boolean(token && batchId),
    // queued / running / post_waiting 都 3 秒；终态停止。post_waiting 时也轮询是为了能感知到
    // 用户在别处补救后后端自动推 running（理论上后端 post_waiting 不会自动转，但保留 polling 不亏）。
    refetchInterval: (query) => {
      const status = (query.state.data as PipelineBatchDetail | undefined)?.batch.status;
      if (status === "queued" || status === "running" || status === "post_waiting") return 3000;
      return false;
    },
  });
  const detail = batchQuery.data;
  const status: PipelineBatchStatus | undefined = detail?.batch.status;

  // 首次进入 post_waiting 状态时自动拉一次 recheck-post 拿初始 missing 列表；
  // 之后 hideDecisionCard 状态切换不再重复触发；用户点「重新检查」会单独发请求。
  useEffect(() => {
    if (!token || !batchId) return;
    if (status !== "post_waiting") return;
    if (decisionCardHidden) return;
    // 没拿过、并且当前还没数据时触发一次
    let cancelled = false;
    (async () => {
      try {
        const resp = await recheckMyPipelineBatchPost(token, batchId);
        if (cancelled) return;
        setMissing(resp.missing || []);
        // 后端如果在 recheck 时把 status 推 running（missing 为空），刷新 cache
        queryClient.setQueryData<PipelineBatchDetail>([...BATCHES_QUERY_KEY, batchId], (old) => {
          if (!old) return old;
          return { ...old, batch: resp.batch };
        });
      } catch {
        // 静默：网络抖动时下次轮询会再拉；用户也可手动点重新检查
      }
    })();
    return () => {
      cancelled = true;
    };
    // 只对 status 进入 post_waiting 这一刻反应
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, batchId, token]);

  // 「全部启动」：把所有 main run 从 paused → queued（并清旧产物，跟 pipeline-mode 的批量启动一致语义）
  const startAllMutation = useMutation({
    mutationFn: async () => {
      if (!detail) return;
      const mains = detail.mainRuns;
      // 串行 PUT 避免一次性几十个并发；调度器最终 cap=3 跑。
      const updated: PipelineRun[] = [];
      for (const run of mains) {
        const next: PipelineRun = {
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
        };
        try {
          const saved = await saveMyPipelineRun(token, next);
          updated.push(saved);
        } catch {
          // 单条失败不阻断
        }
      }
      return updated;
    },
    onSuccess: (updated) => {
      if (!updated) return;
      // 详情 cache + 列表 cache 都同步乐观更新
      queryClient.setQueryData<PipelineBatchDetail>([...BATCHES_QUERY_KEY, batchId], (old) => {
        if (!old) return old;
        const map = new Map(updated.map((run) => [run.id, run]));
        return { ...old, mainRuns: old.mainRuns.map((run) => map.get(run.id) || run) };
      });
      queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
        if (!old) return old;
        const map = new Map(updated.map((run) => [run.id, run]));
        return { ...old, items: old.items.map((item) => map.get(item.id) || item) };
      });
      queryClient.invalidateQueries({ queryKey: BATCHES_QUERY_KEY });
      message.success(`已启动 ${updated.length} 条主条`);
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "启动失败");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteMyPipelineBatch(token, batchId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: BATCHES_QUERY_KEY });
      message.success("已删除批量任务");
      router.push("/agents");
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "删除失败");
    },
  });

  // 「继续执行（跳过缺失）」：让后端把 post 段推 queued
  const continuePostMutation = useMutation({
    mutationFn: () => decideMyPipelineBatchPost(token, batchId, "continue"),
    onSuccess: (next) => {
      queryClient.setQueryData<PipelineBatchDetail>([...BATCHES_QUERY_KEY, batchId], next);
      queryClient.invalidateQueries({ queryKey: BATCHES_QUERY_KEY });
      setMissing([]);
      setDecisionCardHidden(false);
      message.success("已启动后处理");
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "启动后处理失败");
    },
  });

  // 「跳过后处理」：删 post runs + batch 转终态
  const skipPostMutation = useMutation({
    mutationFn: () => decideMyPipelineBatchPost(token, batchId, "skip"),
    onSuccess: (next) => {
      queryClient.setQueryData<PipelineBatchDetail>([...BATCHES_QUERY_KEY, batchId], next);
      queryClient.invalidateQueries({ queryKey: BATCHES_QUERY_KEY });
      setMissing([]);
      setDecisionCardHidden(false);
      message.success("已跳过后处理");
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "跳过失败");
    },
  });

  // 「重新检查 sources」
  const recheckMutation = useMutation({
    mutationFn: () => recheckMyPipelineBatchPost(token, batchId),
    onSuccess: (resp) => {
      setMissing(resp.missing || []);
      queryClient.setQueryData<PipelineBatchDetail>([...BATCHES_QUERY_KEY, batchId], (old) => {
        if (!old) return old;
        return { ...old, batch: resp.batch };
      });
      queryClient.invalidateQueries({ queryKey: BATCHES_QUERY_KEY });
      if (!resp.missing || resp.missing.length === 0) {
        message.success("sources 已齐全，后处理已启动");
      } else {
        message.warning(`仍有 ${resp.missing.length} 项不可用`);
      }
      // 用户主动点检查，需要再次显示决策卡（之前隐藏过也要打开）
      setDecisionCardHidden(false);
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "重新检查失败");
    },
  });

  const handleDelete = () => {
    if (!detail) return;
    modal.confirm({
      title: "删除批量任务",
      content: `确定删除「${detail.batch.name || "未命名批次"}」吗？该批次下所有 main / post run 会一并被删，产物图本身保留在图床里。`,
      okText: "删除",
      okButtonProps: { danger: true, loading: deleteMutation.isPending },
      cancelText: "取消",
      onOk: () => deleteMutation.mutate(),
    });
  };

  const handleSkipPost = () => {
    modal.confirm({
      title: "确定跳过后处理？",
      content: "跳过后所有 post run 会被删除，批次将直接收敛为终态（success / partial / failed）。此操作不可撤销。",
      okText: "跳过后处理",
      okButtonProps: { danger: true, loading: skipPostMutation.isPending },
      cancelText: "取消",
      onOk: () => skipPostMutation.mutate(),
    });
  };

  const handleDownloadZip = async () => {
    if (!detail) return;
    setDownloading(true);
    try {
      await downloadPipelineBatchZip(detail.batch.id, detail.batch.name || `pipeline-batch-${detail.batch.id.slice(-6)}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "下载失败");
    } finally {
      setDownloading(false);
    }
  };

  // 跳转到单条 run 详情页
  const openRun = (runId: string) => {
    router.push(`/agents/runs/${runId}`);
  };

  const mainSummary = useMemo(() => {
    if (!detail) return null;
    const success = detail.mainRuns.filter((run) => run.status === "success").length;
    const failed = detail.mainRuns.filter((run) => run.status === "failed" || run.status === "partial").length;
    return { success, failed, total: detail.mainRuns.length };
  }, [detail]);

  const postSummary = useMemo(() => {
    if (!detail) return null;
    const success = detail.postRuns.filter((run) => run.status === "success").length;
    const failed = detail.postRuns.filter((run) => run.status === "failed" || run.status === "partial").length;
    return { success, failed, total: detail.postRuns.length };
  }, [detail]);

  if (batchQuery.isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-stone-500">加载中…</div>;
  }
  if (batchQuery.error || !detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-stone-500">
        <p>{batchQuery.error instanceof Error ? batchQuery.error.message : "批量任务不存在或已被删除"}</p>
        <Button onClick={() => router.push("/agents")}>返回列表</Button>
      </div>
    );
  }

  const { batch } = detail;
  const isTerminal = batch.status === "success" || batch.status === "partial" || batch.status === "failed";
  const isQueued = batch.status === "queued";
  const isPostWaiting = batch.status === "post_waiting";

  const statusPill = (() => {
    switch (batch.status) {
      case "queued":
        return <Tag className="m-0">待启动</Tag>;
      case "running":
        return <Tag color="blue" className="m-0">运行中</Tag>;
      case "post_waiting":
        return <Tag color="gold" className="m-0">待你决定后处理</Tag>;
      case "success":
        return <Tag color="green" className="m-0">全部完成</Tag>;
      case "partial":
        return <Tag color="orange" className="m-0">部分完成</Tag>;
      case "failed":
        return <Tag color="red" className="m-0">失败</Tag>;
      default:
        return null;
    }
  })();

  const mainPercent = mainSummary && mainSummary.total > 0 ? Math.round((mainSummary.success / mainSummary.total) * 100) : 0;
  const postPercent = postSummary && postSummary.total > 0 ? Math.round((postSummary.success / postSummary.total) * 100) : 0;

  return (
    <main className="thin-scrollbar mx-auto h-full w-full max-w-[1600px] overflow-y-auto p-4 lg:p-6">
      {/* 顶栏 */}
      <header className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 bg-card p-3 shadow-sm dark:border-stone-800">
        <Button icon={<ArrowLeft className="size-4" />} onClick={() => router.push("/agents")}>返回</Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Typography.Title level={4} className="!mb-0 !text-base sm:!text-lg">
              {batch.name || "未命名批次"}
            </Typography.Title>
            {statusPill}
            <Typography.Text type="secondary" className="!text-xs">
              {batch.totalCount} 条主条{batch.postEnabled ? ` · 后处理：${batch.postName || "未命名"}` : " · 无后处理"}
            </Typography.Text>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {isQueued ? (
            <Button
              type="primary"
              icon={<Play className="size-4" />}
              loading={startAllMutation.isPending}
              onClick={() => startAllMutation.mutate()}
            >
              全部启动
            </Button>
          ) : null}
          {isTerminal ? (
            <Button
              icon={<Download className="size-4" />}
              loading={downloading}
              onClick={() => void handleDownloadZip()}
            >
              下载所有产物 (zip)
            </Button>
          ) : null}
          <Button danger icon={<Trash2 className="size-4" />} onClick={handleDelete}>删除</Button>
        </div>
      </header>

      {/* 主条阶段 */}
      <section className="mb-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Typography.Text strong className="!text-sm">
              主条阶段
            </Typography.Text>
            {mainSummary ? (
              <span className="text-xs text-stone-500 dark:text-stone-400">
                {mainSummary.success}/{mainSummary.total} 成功
                {mainSummary.failed > 0 ? ` · ${mainSummary.failed} 失败` : ""}
              </span>
            ) : null}
          </div>
          <div className="w-40">
            <Progress percent={mainPercent} size="small" showInfo={false} className="!mb-0" />
          </div>
        </div>
        {detail.mainRuns.length === 0 ? (
          <div className="rounded-lg border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500 dark:border-stone-700">
            该批次没有主条 run
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {detail.mainRuns.map((run) => (
              <PipelineRunCard
                key={run.id}
                run={run}
                onOpen={() => openRun(run.id)}
                onDownload={() => {
                  // 复用单 run 下载入口
                  message.info("请到该主条详情页内下载单条 zip，或在批次终态时使用上方「下载所有产物」打包下载");
                }}
                onDelete={() => message.info("批量任务的 main run 不可单独删除，请删除整个批次")}
                onDuplicate={() => message.info("批量任务的 main run 不支持复制；如需重新跑请在批次列表新建一次")}
                onSeedUploaded={() => {/* seed 在 batch 创建时已锁定，不再支持替换 */}}
                onStart={() => {/* 主条单条启动入口走详情页 */}}
                selected={false}
                onSelectedChange={() => {/* batch 详情下不提供单条勾选 */}}
                eligible={false}
                downloading={false}
              />
            ))}
          </div>
        )}
      </section>

      {/* 后处理决策卡：仅 post_waiting 时显示，用户「我先去补救」后可暂时隐藏 */}
      {isPostWaiting && !decisionCardHidden ? (
        <section className="mb-5 rounded-lg border-2 border-amber-300 bg-amber-50/50 p-4 dark:border-amber-700 dark:bg-amber-950/20">
          <div className="mb-2 flex items-center gap-2">
            <AlertTriangle className="size-5 text-amber-500" />
            <Typography.Text strong className="!text-sm">
              {missing.length > 0 ? "后处理 sources 有缺失" : "等待你决定是否启动后处理"}
            </Typography.Text>
          </div>
          <div className="mb-3 text-sm text-stone-700 dark:text-stone-200">
            {missing.length > 0 ? (
              <>
                <p className="mb-2">
                  后端在你跑完主条后检查了你配置的 sources，发现 {missing.length} 个不可用：
                </p>
                <ul className="ml-5 list-disc space-y-1 text-xs text-stone-600 dark:text-stone-300">
                  {missing.map((item, index) => (
                    <li key={`${item.runId}-${item.stepIndex}-${index}`}>{item.reason}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>所有 sources 已就绪，可以继续启动后处理。</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="primary"
              loading={continuePostMutation.isPending}
              onClick={() => continuePostMutation.mutate()}
            >
              {missing.length > 0 ? "继续执行（跳过缺失）" : "启动后处理"}
            </Button>
            {missing.length > 0 ? (
              <Button onClick={() => setDecisionCardHidden(true)}>
                我先去补救
              </Button>
            ) : null}
            <Button
              danger
              loading={skipPostMutation.isPending}
              onClick={handleSkipPost}
            >
              跳过后处理
            </Button>
            <Button
              icon={<RefreshCw className="size-3.5" />}
              loading={recheckMutation.isPending}
              onClick={() => recheckMutation.mutate()}
            >
              重新检查 sources
            </Button>
          </div>
          {missing.length > 0 ? (
            <p className="mt-2 text-[11px] text-stone-500 dark:text-stone-400">
              「我先去补救」会暂时隐藏这张卡片；请到对应主条详情页重做该步骤，回来后点「重新检查 sources」。
            </p>
          ) : null}
        </section>
      ) : null}

      {/* 当卡片被用户主动隐藏时，留一个浮条让用户重新触发检查 */}
      {isPostWaiting && decisionCardHidden ? (
        <section className="mb-5 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/30 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/10">
          <AlertTriangle className="size-4 text-amber-500" />
          <span className="text-xs text-stone-600 dark:text-stone-300">
            决策卡已隐藏。补救完成后请点「重新检查 sources」。
          </span>
          <Button
            size="small"
            icon={<RefreshCw className="size-3.5" />}
            loading={recheckMutation.isPending}
            onClick={() => recheckMutation.mutate()}
          >
            重新检查 sources
          </Button>
          <Button size="small" type="link" onClick={() => setDecisionCardHidden(false)}>
            重新显示决策卡
          </Button>
        </section>
      ) : null}

      {/* 后处理阶段：仅 postEnabled */}
      {batch.postEnabled ? (
        <section className="mb-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Typography.Text strong className="!text-sm">
                后处理阶段
              </Typography.Text>
              {postSummary ? (
                <span className="text-xs text-stone-500 dark:text-stone-400">
                  {postSummary.success}/{postSummary.total} 完成
                  {postSummary.failed > 0 ? ` · ${postSummary.failed} 失败` : ""}
                </span>
              ) : null}
            </div>
            <div className="w-40">
              <Progress percent={postPercent} size="small" showInfo={false} className="!mb-0" />
            </div>
          </div>
          {detail.postRuns.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500 dark:border-stone-700">
              {isPostWaiting ? "等你决定后才会生成后处理 run" : "暂无后处理 run"}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {detail.postRuns.map((run) => (
                <PipelineRunCard
                  key={run.id}
                  run={run}
                  onOpen={() => openRun(run.id)}
                  onDownload={() => {
                    message.info("请到该后处理 run 详情页内下载单条 zip，或在批次终态时使用上方「下载所有产物」打包下载");
                  }}
                  onDelete={() => message.info("批量任务的 post run 不可单独删除，请删除整个批次")}
                  onDuplicate={() => message.info("批量任务的 post run 不支持复制")}
                  onSeedUploaded={() => {/* post run 的输入由 sources 决定，不允许替换 seed */}}
                  onStart={() => {/* post run 单条启动入口走详情页 */}}
                  selected={false}
                  onSelectedChange={() => {/* batch 详情下不提供单条勾选 */}}
                  eligible={false}
                  downloading={false}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}
    </main>
  );
}
