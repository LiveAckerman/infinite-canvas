"use client";

import { ChevronRight, ClipboardPaste, Copy, Download, ImagePlus, Loader2, Play, RotateCw, Trash2, Upload } from "lucide-react";
import { App, Button, Checkbox, Image, Tag, Tooltip, Typography } from "antd";
import { useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent } from "react";

import { useImageUploader } from "@/lib/use-image-uploader";
import { imageUrl } from "@/services/image-storage";
import type { PipelineRun } from "@/services/api/pipeline-runs";

const MAX_STEP_THUMBS = 6;

type Props = {
  run: PipelineRun;
  onOpen: () => void;
  onDownload: () => void;
  onDelete: () => void;
  // 复制：用同一个 pipelineId 起一条新的空 seed run（语义 = 「用同一模板再跑一条」）
  onDuplicate: () => void;
  // 上传完原图：父层 PUT 写回 seedKey，但 status 保持 paused，等用户点「执行」
  onSeedUploaded: (seedKey: string) => void;
  // 用户点单条「▶ 执行」时触发：父层 PUT 把 status 推到 queued
  onStart: () => void;
  // 多选状态：勾中 = 该 run 进入批量执行候选
  selected: boolean;
  onSelectedChange: (checked: boolean) => void;
  // 这条 run 是否「可执行」（=已上传原图 + 处于 paused 待执行）。决定 Checkbox 是否可勾、单卡「执行」按钮是否显示
  eligible: boolean;
  downloading?: boolean;
  // 批次模式专用：传了 onRetry → 当 run.status === "failed" 时显示「重试」按钮直接重跑（不用点进详情页）。
  // 不影响 pipeline-mode 调用方（默认 undefined → 没按钮）。
  onRetry?: () => void;
  retrying?: boolean;
  // 批次模式专用：隐藏「复制」按钮（批量主条共享同 batchId，不允许复制成游离的 run）。
  hideDuplicate?: boolean;
  // 批次模式专用：隐藏「删除」按钮（批量主条不能单删，要删整个 batch；按钮存在反而误导）。
  hideDelete?: boolean;
};

// 「执行流程」列表里的一张卡：勾选 + 名字 + 状态 + 进度缩略图行 + 操作按钮。
// 一眼看清这条 run 的状态和每步成果，并能单条 / 多选 / 全部执行。
// run.seedKey 为空时（一般是刚通过 Dropdown 添加或复制出来的新 run，状态=paused），
// 卡片中部会变成「待上传原图」的拖入/上传 UI；上传完调 onSeedUploaded 让父层 PUT 写回（保持 paused 状态）。
// 用户点单条「▶ 执行」按钮 / 顶部「执行选中」/「全部执行」时才真正进 queued 让调度器跑。
export function PipelineRunCard({ run, onOpen, onDownload, onDelete, onDuplicate, onSeedUploaded, onStart, selected, onSelectedChange, eligible, downloading, onRetry, retrying, hideDuplicate, hideDelete }: Props) {
  const { message } = App.useApp();
  const uploadWithToast = useImageUploader();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragHighlight, setDragHighlight] = useState(false);
  const [uploading, setUploading] = useState(false);

  const summary = useMemo(() => {
    const successCount = run.steps.filter((step) => step.status === "success").length;
    const failedCount = run.steps.filter((step) => step.status === "failed").length;
    const runningIndex = run.steps.findIndex((step) => step.status === "running");
    return { successCount, failedCount, runningIndex, total: run.steps.length };
  }, [run]);

  const needsSeed = !run.seedKey;

  const statusPill = (() => {
    if (needsSeed) return <Tag color="gold" className="m-0">待上传原图</Tag>;
    switch (run.status) {
      // paused + 有 seed = 用户手动启动前的等待态，区别于「已暂停」的「中途断电」语义
      case "paused": return <Tag color="gold" className="m-0">待执行</Tag>;
      case "queued": return <Tag className="m-0">排队中</Tag>;
      case "running": return <Tag color="blue" className="m-0">运行中 {summary.runningIndex >= 0 ? `${summary.runningIndex + 1}/${summary.total}` : ""}</Tag>;
      case "success": return <Tag color="green" className="m-0">全部完成</Tag>;
      case "partial": return <Tag color="orange" className="m-0">部分完成 {summary.successCount}/{summary.total}</Tag>;
      case "failed": return <Tag color="red" className="m-0">失败</Tag>;
      default: return null;
    }
  })();

  // 上传原图：拖入 / 粘贴 / 选择文件三入口；走通用 useImageUploader，自动 toast。
  const handleFile = async (file?: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      message.error("请选择图片文件");
      return;
    }
    setUploading(true);
    try {
      const stored = await uploadWithToast(file, { label: "原图" });
      onSeedUploaded(stored.storageKey);
    } catch {
      // uploader 已弹错误
    } finally {
      setUploading(false);
    }
  };
  const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.clipboardData?.items || []);
    const file = items.find((item) => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void handleFile(file);
  };
  const handleClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        await handleFile(new File([blob], `clipboard-${Date.now()}.png`, { type: imageType }));
        return;
      }
      message.error("剪切板里没有可读取的图片");
    } catch {
      message.error("剪切板里没有可读取的图片");
    }
  };
  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragHighlight(true);
  };
  const handleDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragHighlight(false);
  };
  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragHighlight(false);
    const file = Array.from(event.dataTransfer.files || []).find((item) => item.type.startsWith("image/"));
    if (!file) {
      if (event.dataTransfer.files?.length) message.error("拖入的不是图片，已忽略");
      return;
    }
    void handleFile(file);
  };

  const visibleSteps = run.steps.slice(0, MAX_STEP_THUMBS);
  const hiddenCount = Math.max(0, run.steps.length - MAX_STEP_THUMBS);
  const hasAnyOutput = run.steps.some((step) => Boolean(step.outputKey));
  const canDownload = hasAnyOutput;
  const createdLabel = useMemo(() => formatRelative(run.createdAt), [run.createdAt]);

  return (
    <div className={`flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-sm transition hover:shadow-md ${selected && eligible ? "border-blue-400 ring-1 ring-blue-200 dark:border-blue-500 dark:ring-blue-900" : "border-stone-200 dark:border-stone-800"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <Tooltip title={eligible ? "勾选纳入「执行选中」批量操作" : "只有已上传原图、未在跑的流程可勾选"}>
            <Checkbox
              className="mt-0.5 shrink-0"
              checked={selected && eligible}
              disabled={!eligible}
              onChange={(event) => onSelectedChange(event.target.checked)}
            />
          </Tooltip>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Typography.Text strong className="!text-sm">{run.pipelineName || "未命名流水线"}</Typography.Text>
              {statusPill}
              <Typography.Text type="secondary" className="!text-xs">{createdLabel}</Typography.Text>
            </div>
          </div>
        </div>
        {!hideDelete ? (
          <Tooltip title="删除该执行流程">
            <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete} />
          </Tooltip>
        ) : null}
      </div>

      {/* 中部：要么是「上传原图」区（待上传时），要么是步骤进度缩略图行 */}
      {needsSeed ? (
        <div
          className={`relative flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-4 text-center transition-colors ${dragHighlight ? "border-blue-500 bg-blue-50/40 dark:border-blue-400 dark:bg-blue-500/10" : "border-stone-300 dark:border-stone-700"}`}
          onPaste={handlePaste}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <ImagePlus className="size-7 text-stone-400" />
          <div className="text-sm text-stone-600 dark:text-stone-300">{dragHighlight ? "松开以添加原图" : "上传原图后，点下方「执行」开始跑"}</div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button size="small" loading={uploading} icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>上传</Button>
            <Button size="small" disabled={uploading} icon={<ClipboardPaste className="size-3.5" />} onClick={() => void handleClipboard()}>剪切板</Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              void handleFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          {/* 静态显示模板预览：每步角色名一排 chip，让用户知道这条用的是什么模板 */}
          {visibleSteps.length ? (
            <div className="mt-1 flex flex-wrap justify-center gap-1.5">
              {visibleSteps.map((step, index) => (
                <span key={step.stepId} className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                  {index + 1}. {step.agentName || "已删除"}
                </span>
              ))}
              {hiddenCount > 0 ? <span className="text-[11px] text-stone-400">+{hiddenCount}</span> : null}
            </div>
          ) : null}
        </div>
      ) : (
        // PreviewGroup 包裹整行缩略图：点任意一张能打开全屏预览 + 左右切换
        <Image.PreviewGroup>
          <div className="hover-scrollbar flex items-center gap-1.5 overflow-x-auto pb-1">
            <StepThumb url={run.seedKey ? imageUrl(run.seedKey) : ""} label="原图" status="seed" />
            {visibleSteps.map((step, index) => (
              <span key={step.stepId} className="flex shrink-0 items-center gap-1.5">
                <ChevronRight className="size-3.5 shrink-0 text-stone-400" />
                <StepThumb
                  url={step.outputKey ? imageUrl(step.outputKey) : ""}
                  label={`#${index + 1} ${step.agentName || "已删除"}`}
                  status={step.status}
                />
              </span>
            ))}
            {hiddenCount > 0 ? (
              <span className="ml-1 shrink-0 text-xs text-stone-400">+{hiddenCount} 步</span>
            ) : null}
          </div>
        </Image.PreviewGroup>
      )}

      <div className="flex flex-wrap gap-2">
        {/* 主按钮：有产物（success / partial / failed / 跑过一半）→「打开」看结果；
            纯新建未跑过 / 没产物 →「执行」直接启动；needsSeed → 啥也不显示等用户上传。 */}
        {hasAnyOutput && !needsSeed ? (
          <Button type="primary" onClick={onOpen}>打开</Button>
        ) : eligible ? (
          <Button type="primary" icon={<Play className="size-3.5" />} onClick={onStart}>执行</Button>
        ) : null}
        {/* 重新执行：仅有产物且 eligible 时显示（跟主按钮「打开」并列），点了清旧产物重头跑 */}
        {eligible && hasAnyOutput ? (
          <Button icon={<RotateCw className="size-3.5" />} onClick={onStart} title="清空旧产物，从第 1 步重新跑">重新执行</Button>
        ) : null}
        {/* 批次模式专用「重做 / 重试」：父层传了 onRetry + 这条主条已跑完（success/partial/failed）→ 显示。
            点了清掉这条主条所有步骤的产物、从第 1 步重新跑这一条（不影响批次其它主条，也不用进详情页）。
            失败的叫「重试」(primary 强调)，成功 / 部分完成的叫「重做」。 */}
        {onRetry && (run.status === "success" || run.status === "partial" || run.status === "failed") ? (
          <Button
            type={run.status === "failed" ? "primary" : "default"}
            icon={<RotateCw className="size-3.5" />}
            loading={retrying}
            onClick={onRetry}
            title="清空这条主条的产物，从第 1 步重新跑（不影响其它主条）"
          >
            {run.status === "failed" ? "重试" : "重做"}
          </Button>
        ) : null}
        {!hideDuplicate ? (
          <Button icon={<Copy className="size-3.5" />} onClick={onDuplicate} title="用同一个模板再起一条新的（需要重新上传原图）">复制</Button>
        ) : null}
        {!needsSeed && hasAnyOutput ? (
          <Button icon={<Download className="size-3.5" />} loading={downloading} disabled={!canDownload} onClick={onDownload}>下载所有产物 (zip)</Button>
        ) : null}
      </div>
    </div>
  );
}

// 单步缩略图：根据状态着边框色。无图时显示占位。
function StepThumb({ url, label, status }: { url: string; label: string; status: "seed" | "idle" | "running" | "success" | "failed" }) {
  const ringColor = (() => {
    switch (status) {
      case "seed": return "ring-stone-300 dark:ring-stone-600";
      case "success": return "ring-green-500";
      case "failed": return "ring-red-500";
      case "running": return "ring-blue-500 animate-pulse";
      default: return "ring-stone-200 dark:ring-stone-700";
    }
  })();
  return (
    <Tooltip title={label}>
      <div className={`flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-stone-50 ring-2 ${ringColor} dark:bg-stone-900`}>
        {url ? (
          // 用 antd Image 替代原生 img，点击弹全屏预览（外层 Image.PreviewGroup 串起所有 thumb）。
          // rootClassName 强制让 antd 外层 span 充满 size-12 容器，不破坏现有样式。
          <Image
            src={url}
            alt={label}
            width={48}
            height={48}
            className="!size-12 object-cover"
            rootClassName="!block !size-12 cursor-zoom-in"
            preview={{ mask: false }}
          />
        ) : status === "running" ? (
          <Loader2 className="size-4 animate-spin text-blue-500" />
        ) : (
          <span className="text-[10px] text-stone-400">—</span>
        )}
      </div>
    </Tooltip>
  );
}

// 「3 分钟前 / 1 小时前 / yyyy-MM-dd」简易相对时间。RFC3339 解析失败兜底显示原字符串。
function formatRelative(timestamp: string): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const diff = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return date.toLocaleDateString("zh-CN");
}
