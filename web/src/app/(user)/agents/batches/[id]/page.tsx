"use client";

import { AlertTriangle, ArrowLeft, Download, Play, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { App, Button, Image, Progress, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useNav } from "@/lib/use-nav";
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
  collectRunProductKeys,
  downloadSingleImage,
  resetRunForRedo,
  saveMyPipelineRun,
  type PipelineRun,
  type PipelineRunListResponse,
} from "@/services/api/pipeline-runs";

import { PipelineRunCard } from "../../components/pipeline-run-card";
import { RUNS_QUERY_KEY, resolvePostSourceKeys } from "../../hooks/use-pipeline-run-manager";
import { imageUrl } from "@/services/image-storage";

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
  const nav = useNav();
  const queryClient = useQueryClient();
  const token = useUserStore((state) => state.token);

  // missing 列表：mount 时如果是 post_waiting 自动拉一次 recheck-post；用户后续重新检查 / 决定时刷新
  const [missing, setMissing] = useState<RecheckPostMissingItem[]>([]);
  // 「我先去补救」=> 用户暂时把决策卡隐藏；只能等用户主动点旁边的「重新检查 sources」再次显示
  const [decisionCardHidden, setDecisionCardHidden] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [redoing, setRedoing] = useState(false);
  // 后处理 run 重做时锁定 button，避免重复点击触发多次 PUT
  const [retryingPostId, setRetryingPostId] = useState<string>("");
  // 跟 post 那条独立：主条「失败」直接在卡片上点「重试」时给按钮单独 loading 态
  const [retryingMainId, setRetryingMainId] = useState<string>("");

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

  // batch detail polling 每次拿到新数据，把 mainRuns + postRuns 同步合并到 RUNS_QUERY_KEY list cache，
  // 让调度器（usePipelineRunManager 订阅 list cache）能立刻看到这些 runs 并启动跑步骤。
  // 不做的话用户停在 batch detail 页时，runs 一直 queued 不动（list cache 是空的）。
  useEffect(() => {
    if (!detail) return;
    const batchRuns = [...detail.mainRuns, ...detail.postRuns];
    if (batchRuns.length === 0) return;
    queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
      if (!old) return { items: batchRuns, total: batchRuns.length };
      const map = new Map(old.items.map((r) => [r.id, r]));
      for (const r of batchRuns) map.set(r.id, r);
      const items = Array.from(map.values());
      return { ...old, items, total: items.length };
    });
  }, [detail, queryClient]);

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
        try {
          updated.push(await saveMyPipelineRun(token, resetRunForRedo(run, "queued")));
        } catch {
          // 单条失败不阻断
        }
      }
      return { updated, total: mains.length };
    },
    onSuccess: (result) => {
      if (!result) return;
      const { updated, total } = result;
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
      const failed = total - updated.length;
      if (updated.length > 0 && failed > 0) message.warning(`已启动 ${updated.length} 条，${failed} 条启动失败，可对失败主条单独重试`);
      else if (updated.length > 0) message.success(`已启动 ${updated.length} 条主条`);
      else message.error("启动失败");
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "启动失败");
    },
  });

  // 重试单条 failed 主条：跟 handleRetryPostRun 一样的语义（reset run + steps → 写库 → 乐观 cache 更新），
  // 只是写回的是 mainRuns 而不是 postRuns。调度器订阅 list cache 自动捡起来跑。
  // 之前批次详情页里失败主条只能点进详情页才能重跑，现在卡片上直接「重试」按钮一键搞定。
  const handleRetryMainRun = async (run: PipelineRun) => {
    setRetryingMainId(run.id);
    try {
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
      const saved = await saveMyPipelineRun(token, next);
      queryClient.setQueryData<PipelineBatchDetail>([...BATCHES_QUERY_KEY, batchId], (old) => {
        if (!old) return old;
        return { ...old, mainRuns: old.mainRuns.map((item) => (item.id === saved.id ? saved : item)) };
      });
      queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
        if (!old) return { items: [saved], total: 1 };
        const exists = old.items.some((item) => item.id === saved.id);
        if (exists) return { ...old, items: old.items.map((item) => (item.id === saved.id ? saved : item)) };
        return { ...old, items: [...old.items, saved], total: old.total + 1 };
      });
      message.success("已重新排队，稍等就会自动开跑");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "重试失败");
    } finally {
      setRetryingMainId("");
    }
  };

  // 重做单条 failed / paused 的 post run：把 run + step 全部 reset 到 queued/idle 写库；
  // 调度器订阅 cache 变化会自动捡起来跑（v0.0.28 起 agents 闭包 race 有 ref + retry 兜底）。
  const handleRetryPostRun = async (run: PipelineRun) => {
    setRetryingPostId(run.id);
    try {
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
      const saved = await saveMyPipelineRun(token, next);
      // detail / list 两份 cache 都乐观写一份，让调度器立刻能看到
      queryClient.setQueryData<PipelineBatchDetail>([...BATCHES_QUERY_KEY, batchId], (old) => {
        if (!old) return old;
        return { ...old, postRuns: old.postRuns.map((item) => (item.id === saved.id ? saved : item)) };
      });
      queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
        if (!old) return { items: [saved], total: 1 };
        const exists = old.items.some((item) => item.id === saved.id);
        if (exists) return { ...old, items: old.items.map((item) => (item.id === saved.id ? saved : item)) };
        return { ...old, items: [...old.items, saved], total: old.total + 1 };
      });
      message.success("已重新排队，稍等就会自动开跑");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "重做失败");
    } finally {
      setRetryingPostId("");
    }
  };

  const deleteMutation = useMutation({
    mutationFn: () => deleteMyPipelineBatch(token, batchId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: BATCHES_QUERY_KEY });
      message.success("已删除批量任务");
      nav.push("/agents");
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
      content: `确定删除「${detail.batch.name || "未命名批次"}」吗？该批次下所有 main / post run 以及关联的图片资源（原图、各步产物）都会一并删除（仍被别处引用的图片会保留）。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      // mutateAsync 返回 Promise → antd 自动转 OK 按钮 loading；静态 isPending 在 confirm() 调用时已被快照。
      onOk: () => deleteMutation.mutateAsync().catch(() => undefined),
    });
  };

  // 「重做整个批次」：终态时从头重跑全批。所有 main run 重置成 queued、post run 重置成 paused（steps 清回 idle），
  // 写库后乐观更新 detail / list 两份 cache —— 调度器立刻接管跑 main，跑完后端再把 post 推 queued 接着跑。
  const handleRedoBatch = () => {
    if (!detail) return;
    modal.confirm({
      title: "重做整个批量任务？",
      content: `「${detail.batch.name || "未命名批次"}」会清掉现有产物，从头重新跑一遍所有主条和后处理（按现在的输入），重新消耗额度。确定吗？`,
      okText: "重做",
      cancelText: "取消",
      onOk: async () => {
        setRedoing(true);
        try {
          const mains = detail.mainRuns.map((run) => resetRunForRedo(run, "queued"));
          const posts = detail.postRuns.map((run) => resetRunForRedo(run, "paused"));
          const savedMains: PipelineRun[] = [];
          const savedPosts: PipelineRun[] = [];
          for (const next of mains) {
            try { savedMains.push(await saveMyPipelineRun(token, next)); } catch { /* 单条失败不阻断 */ }
          }
          for (const next of posts) {
            try { savedPosts.push(await saveMyPipelineRun(token, next)); } catch { /* 单条失败不阻断 */ }
          }
          const all = [...savedMains, ...savedPosts];
          // 乐观写 detail（本页 PostRunCard / 主条卡立即反映）+ list cache（调度器读这里）
          queryClient.setQueryData<PipelineBatchDetail>([...BATCHES_QUERY_KEY, batchId], (old) => {
            if (!old) return old;
            const map = new Map(all.map((r) => [r.id, r]));
            return {
              ...old,
              mainRuns: old.mainRuns.map((r) => map.get(r.id) || r),
              postRuns: old.postRuns.map((r) => map.get(r.id) || r),
            };
          });
          queryClient.setQueryData<PipelineRunListResponse>(RUNS_QUERY_KEY, (old) => {
            if (!old) return { items: all, total: all.length };
            const map = new Map(old.items.map((r) => [r.id, r]));
            for (const r of all) map.set(r.id, r);
            const items = Array.from(map.values());
            return { ...old, items, total: items.length };
          });
          queryClient.invalidateQueries({ queryKey: BATCHES_QUERY_KEY });
          queryClient.invalidateQueries({ queryKey: ["my-pipeline-runs"] });
          const failed = mains.length + posts.length - all.length;
          if (all.length > 0 && failed > 0) message.warning(`已重新排队 ${all.length} 条，${failed} 条失败，可对失败项单独重试`);
          else if (all.length > 0) message.success("已重新排队，稍等会自动开跑");
          else message.error("重做失败");
        } catch (error) {
          message.error(error instanceof Error ? error.message : "重做失败");
        } finally {
          setRedoing(false);
        }
      },
    });
  };

  const handleSkipPost = () => {
    modal.confirm({
      title: "确定跳过后处理？",
      content: "跳过后所有 post run 会被删除，批次将直接收敛为终态（success / partial / failed）。此操作不可撤销。",
      okText: "跳过后处理",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => skipPostMutation.mutateAsync().catch(() => undefined),
    });
  };

  const handleDownloadZip = async () => {
    if (!detail) return;
    setDownloading(true);
    try {
      const name = detail.batch.name || `pipeline-batch-${detail.batch.id.slice(-6)}`;
      // 全批次产物 = 所有 main run + post run 的每步产物。只有一个产物时直接下原图。
      const products = [
        ...detail.mainRuns.flatMap(collectRunProductKeys),
        ...detail.postRuns.flatMap(collectRunProductKeys),
      ];
      if (products.length === 1) {
        await downloadSingleImage(products[0], name);
      } else {
        await downloadPipelineBatchZip(detail.batch.id, name);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "下载失败");
    } finally {
      setDownloading(false);
    }
  };

  // 跳转到单条 run 详情页
  const openRun = (runId: string) => {
    nav.push(`/agents/runs/${runId}`);
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

  // 主条阶段是否全部 done（success/partial/failed 都算终态）；只要还有 idle/queued/running/paused/post_waiting 的就算未完成。
  // post 卡片在主条未完成时禁用 + 加蒙层提示，让用户知道在等主条结束。
  const isMainAllDone = useMemo(() => {
    if (!detail || detail.mainRuns.length === 0) return false;
    return detail.mainRuns.every(
      (run) => run.status === "success" || run.status === "partial" || run.status === "failed",
    );
  }, [detail]);

  if (batchQuery.isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-stone-500">加载中…</div>;
  }
  if (batchQuery.error || !detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-stone-500">
        <p>{batchQuery.error instanceof Error ? batchQuery.error.message : "批量任务不存在或已被删除"}</p>
        <Button onClick={() => nav.push("/agents")}>返回列表</Button>
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
        <Button icon={<ArrowLeft className="size-4" />} onClick={() => nav.push("/agents")}>返回</Button>
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
          {isTerminal ? (
            <Button icon={<RotateCw className="size-4" />} loading={redoing} onClick={handleRedoBatch}>
              重做
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
                onDelete={() => {/* hideDelete=true 时按钮不渲染，这里不会触发 */}}
                onDuplicate={() => {/* hideDuplicate=true 时按钮不渲染，这里不会触发 */}}
                onSeedUploaded={() => {/* seed 在 batch 创建时已锁定，不再支持替换 */}}
                onStart={() => {/* 主条单条启动入口走详情页 */}}
                selected={false}
                onSelectedChange={() => {/* batch 详情下不提供单条勾选 */}}
                eligible={false}
                downloading={false}
                // 批次模式：失败主条直接卡片上点重试，不用进详情页
                onRetry={() => void handleRetryMainRun(run)}
                retrying={retryingMainId === run.id}
                hideDuplicate
                hideDelete
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
          {/* 主条未完成时，后处理卡整体禁用（pointer-events-none + 半透明），并加一行顶部提示 banner */}
          {!isMainAllDone && detail.postRuns.length > 0 ? (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
              <span>⏳</span>
              <span>正在等待主条阶段全部跑完，主条结束后这里才会自动开始</span>
            </div>
          ) : null}
          {detail.postRuns.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500 dark:border-stone-700">
              {isPostWaiting ? "等你决定后才会生成后处理 run" : "暂无后处理 run"}
            </div>
          ) : (
            <div
              className={`grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 ${!isMainAllDone ? "pointer-events-none opacity-60" : ""}`}
              aria-disabled={!isMainAllDone}
              title={!isMainAllDone ? "等待主条阶段完成" : undefined}
            >
              {detail.postRuns.map((run) => (
                <PostRunCard
                  key={run.id}
                  run={run}
                  mainRuns={detail.mainRuns}
                  retrying={retryingPostId === run.id}
                  onOpen={() => openRun(run.id)}
                  onRetry={() => void handleRetryPostRun(run)}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}
    </main>
  );
}

// PostRunCard 专门给批量任务的 post run 用的简化卡片。
//   - 跟 main run 不一样：post run 没有 seedKey，它的 references 来自 sourceRefs（指向同 batch
//     里 main runs 的 step 产物）。所以这张卡不显示「待上传原图」UI，而是直接显示「使用 N 张主条产物」
//     横排小缩略图；产物跑出来后展示在右侧（或下方）。
//   - 不复用 PipelineRunCard 是因为它假设了 seedKey 单 seed 语义，强行复用要塞一堆 if branch，
//     不如单写一个干净。
function PostRunCard({
  run,
  mainRuns,
  retrying,
  onOpen,
  onRetry,
}: {
  run: PipelineRun;
  mainRuns: PipelineRun[];
  retrying: boolean;
  onOpen: () => void;
  onRetry: () => void;
}) {
  // 解析 sourceRefs 到实际的图片 storageKey（已经成功的 main run 步骤产物 / seed）
  const sourceKeys = resolvePostSourceKeys(run.sourceRefs || [], mainRuns);
  const step = run.steps[0]; // post run 永远是 single-step
  const outputKey = step?.outputKey || "";
  const agentName = step?.agentName || "未命名角色";

  const statusPill = (() => {
    switch (run.status) {
      case "queued":
        return <Tag color="blue" className="m-0">等待执行</Tag>;
      case "running":
        return <Tag color="blue" className="m-0">执行中…</Tag>;
      case "paused":
        return <Tag color="gold" className="m-0">已暂停</Tag>;
      case "success":
        return <Tag color="green" className="m-0">已完成</Tag>;
      case "partial":
        return <Tag color="orange" className="m-0">部分完成</Tag>;
      case "failed":
        return <Tag color="red" className="m-0">失败</Tag>;
      default:
        return <Tag className="m-0">待运行</Tag>;
    }
  })();

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-card p-3 dark:border-stone-800">
      {/* 标题：角色名 + 状态 */}
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold" title={`后处理 · ${agentName}`}>
          后处理 · {agentName}
        </span>
        {statusPill}
      </div>

      {/* PreviewGroup 串联本卡所有图（sources + 产物）：点任意一张能全屏预览 + 左右切换 */}
      <Image.PreviewGroup>
        {/* 数据源缩略图横排（小图叠放显示，避免占太多空间）；可点击放大 */}
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] text-stone-500 dark:text-stone-400">数据源 {sourceKeys.length} 张</span>
          <div className="flex flex-1 items-center gap-1 overflow-x-auto">
            {sourceKeys.length > 0 ? sourceKeys.slice(0, 8).map((key, idx) => (
              <Image
                key={`${key}-${idx}`}
                src={imageUrl(key)}
                alt={`数据源 ${idx + 1}`}
                width={40}
                height={40}
                className="!size-10 rounded border border-stone-200 object-cover dark:border-stone-800"
                rootClassName="!block !size-10 shrink-0 cursor-zoom-in"
                preview={{ mask: false }}
              />
            )) : (
              <span className="text-[11px] text-amber-600 dark:text-amber-400">⚠ 暂未解析到可用数据源（等待主条阶段完成）</span>
            )}
          </div>
        </div>

        {/* 产物 / 错误：产物图可点击放大 */}
        {outputKey ? (
          <div className="overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
            <Image
              src={imageUrl(outputKey)}
              alt="产物"
              className="!h-32 w-full object-contain cursor-zoom-in"
              rootClassName="!block !w-full"
              preview={{ mask: "点击查看大图" }}
            />
          </div>
        ) : null}
      </Image.PreviewGroup>
      {/* 无产物时：失败显示错误信息，其它显示占位文案 */}
      {!outputKey ? (
        run.status === "failed" && step?.errorMessage ? (
          <div className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-600 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
            <span className="line-clamp-3">{step.errorMessage}</span>
          </div>
        ) : (
          <div className="grid h-20 place-items-center rounded-md bg-stone-50 text-[11px] text-stone-400 dark:bg-stone-900">
            {run.status === "running" ? "正在生成…" : "暂无产物"}
          </div>
        )
      ) : null}

      {/* 操作按钮 */}
      <div className="flex flex-wrap gap-1.5">
        <Button size="small" onClick={onOpen}>打开详情</Button>
        {run.status === "failed" || run.status === "paused" ? (
          <Button
            size="small"
            type="primary"
            icon={<RefreshCw className="size-3.5" />}
            loading={retrying}
            onClick={onRetry}
          >
            重做
          </Button>
        ) : null}
      </div>
    </div>
  );
}
