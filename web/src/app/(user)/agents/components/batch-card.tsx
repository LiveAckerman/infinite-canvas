"use client";

import { Download, Play, Trash2 } from "lucide-react";
import { Button, Progress, Tag, Tooltip, Typography } from "antd";
import { useMemo } from "react";

import type { PipelineBatchListItem } from "@/services/api/pipeline-batches";

type Props = {
  item: PipelineBatchListItem;
  // 跳转到详情页（/agents/batches/{id}）
  onOpen: () => void;
  onDelete: () => void;
  // 「全部启动」：把所有 main run 从 paused → queued，触发调度器跑批
  onStartAll: () => void;
  // 下载该批次的 zip 产物包，仅终态可用
  onDownloadZip: () => void;
  // 「全部启动」按钮的 loading 态
  starting?: boolean;
  // 「下载 zip」按钮的 loading 态。zip 是流式拉，体积大时几秒到十几秒不等，
  // 没 loading 用户以为按钮没生效会狂点。
  downloading?: boolean;
};

// 批量任务列表项卡片。一眼看清这条 batch 的总体状态 + main / post 进度，并提供常用操作入口。
//   - queued → 主操作是「▶ 全部启动」
//   - running / post_waiting → 主操作是「打开」（去详情页继续）
//   - success / partial / failed → 主操作仍是「打开」+「下载 zip」
//   - 删除是次要操作，红色 ghost
//
// 进度计算口径：(mainSuccess + postSuccess) / (mainTotal + postTotal)；
// 没启用 post 时分母自然变成只算主条，跟 UI 描述行一致。
export function BatchCard({ item, onOpen, onDelete, onStartAll, onDownloadZip, starting, downloading }: Props) {
  const isTerminal = item.status === "success" || item.status === "partial" || item.status === "failed";
  const isPostWaiting = item.status === "post_waiting";
  const isQueued = item.status === "queued";

  // 总进度：main + post 合并计算；mainSuccess / postSuccess 来自后端列表聚合。
  // post 未启用时 postTotal == 0、postSuccess == 0，结果等价于「只算主条」。
  const totalDone = item.mainSuccess + item.postSuccess;
  const totalAll = item.mainTotal + item.postTotal;
  const percent = totalAll > 0 ? Math.round((totalDone / totalAll) * 100) : 0;

  const statusPill = useMemo(() => {
    switch (item.status) {
      case "queued":
        return <Tag className="m-0">待启动</Tag>;
      case "running":
        return (
          <Tag color="blue" className="m-0">
            运行中 {totalDone}/{totalAll}
          </Tag>
        );
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
  }, [item.status, totalDone, totalAll]);

  // 进度条颜色跟随状态：失败红、部分橙、其它蓝
  const progressStatus: "active" | "success" | "exception" | "normal" = (() => {
    if (item.status === "failed") return "exception";
    if (item.status === "success") return "success";
    if (item.status === "running" || item.status === "queued") return "active";
    return "normal";
  })();

  const createdLabel = useMemo(() => formatRelative(item.createdAt), [item.createdAt]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-card p-4 shadow-sm transition hover:shadow-md dark:border-stone-800">
      {/* 顶部行：名字 + 状态 + 删除 */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Typography.Text strong className="!text-sm">
              {item.name || "未命名批次"}
            </Typography.Text>
            {statusPill}
            <Typography.Text type="secondary" className="!text-xs">
              {createdLabel}
            </Typography.Text>
          </div>
        </div>
        <Tooltip title="删除该批量任务">
          <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete} />
        </Tooltip>
      </div>

      {/* 描述行：主条数 / 后处理段数 */}
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-stone-500 dark:text-stone-400">
          <span>
            主条 <span className="font-medium text-stone-700 dark:text-stone-200">{item.mainSuccess}/{item.mainTotal}</span>
          </span>
          <span className="text-stone-300 dark:text-stone-600">·</span>
          <span>
            {item.postEnabled ? (
              <>后处理 <span className="font-medium text-stone-700 dark:text-stone-200">{item.postSuccess}/{item.postTotal}</span></>
            ) : (
              "无后处理"
            )}
          </span>
          {item.mainFailed + item.postFailed > 0 ? (
            <>
              <span className="text-stone-300 dark:text-stone-600">·</span>
              <span className="text-red-500">失败 {item.mainFailed + item.postFailed}</span>
            </>
          ) : null}
        </div>
        <Progress
          percent={percent}
          size="small"
          status={progressStatus}
          showInfo={false}
          className="!mb-0"
        />
      </div>

      {/* 按钮组：根据 status 选主操作；「打开」次要总在 */}
      <div className="flex flex-wrap items-center gap-2">
        {isQueued ? (
          <Button
            type="primary"
            icon={<Play className="size-3.5" />}
            loading={starting}
            onClick={onStartAll}
          >
            全部启动
          </Button>
        ) : isPostWaiting ? (
          <Button type="primary" onClick={onOpen}>
            打开决定
          </Button>
        ) : isTerminal ? (
          <Button type="primary" onClick={onOpen}>
            打开
          </Button>
        ) : (
          <Button onClick={onOpen}>打开</Button>
        )}
        {/* 非主操作的「打开」入口：queued 状态主按钮是「全部启动」，还要给一个次要打开入口 */}
        {isQueued ? <Button onClick={onOpen}>打开</Button> : null}
        {isTerminal ? (
          <Button
            icon={<Download className="size-3.5" />}
            loading={downloading}
            onClick={onDownloadZip}
          >
            下载 zip
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// 「3 分钟前 / 1 小时前 / yyyy-MM-dd」简易相对时间。和 pipeline-run-card 保持一致。
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
