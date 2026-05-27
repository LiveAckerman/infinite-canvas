"use client";

import { ExternalLink, Image as ImageIcon, RotateCw } from "lucide-react";
import { Button, Drawer, Empty, Pagination, Select, Tag } from "antd";
import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { formatLocalDateTime } from "@/lib/format-datetime";
import { formatDuration } from "@/lib/image-utils";
import { fetchGenerations, type GenerationRecord } from "@/services/api/generations";
import { imageUrl } from "@/services/image-storage";
import type { Agent } from "@/services/api/agents";
import { useUserStore } from "@/stores/use-user-store";

import { AgentAvatar } from "./agent-avatar";

type AgentRecordsDrawerProps = {
  open: boolean;
  onClose: () => void;
  // 当前用户的全部角色（含已不在工作区里的），用于下拉筛选 + 渲染头像
  agents: Agent[];
  // 由 page 控制：哪个 agent 被选中筛选（"" = 全部本工作台）
  agentFilter: string;
  onAgentFilterChange: (agentId: string) => void;
  // 当前页（由 page 控制，避免 Drawer 关闭重开时丢失分页位置）
  page: number;
  onPageChange: (page: number) => void;
  // 工作台跑完一次后会 bump 这个值，触发 Drawer 内重新拉记录
  refreshKey: number;
};

const PAGE_SIZE = 10;

export function AgentRecordsDrawer({ open, onClose, agents, agentFilter, onAgentFilterChange, page, onPageChange, refreshKey }: AgentRecordsDrawerProps) {
  const token = useUserStore((state) => state.token);
  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  const recordsQuery = useQuery({
    // refreshKey 进 queryKey：父层每次 workstation 跑完 bump 一下，Drawer 自动重拉。
    queryKey: ["agent-generations", agentFilter || "all-agents", page, refreshKey],
    queryFn: () => fetchGenerations(token, {
      page,
      pageSize: PAGE_SIZE,
      // 没选具体 agent 时仍只看「角色工作台」的记录，不要把 /image / canvas 的混进来
      agentId: agentFilter || undefined,
      hasAgent: agentFilter ? undefined : "1",
    }),
    enabled: open && Boolean(token),
    // 不在 Drawer 打开时长时间停留也不刷，节流；用户点击 Drawer 内的刷新 Tag 触发 refetch
    refetchOnWindowFocus: false,
  });

  const records = recordsQuery.data?.items || [];
  const total = recordsQuery.data?.total || 0;

  const agentOptions = useMemo(() => [
    { label: "全部本工作台", value: "" },
    ...agents.map((agent) => ({ label: agent.name, value: agent.id })),
  ], [agents]);

  return (
    <Drawer
      title={
        <div className="flex items-center gap-2">
          <span>生成记录</span>
          <Tag className="m-0">{total}</Tag>
        </div>
      }
      placement="right"
      width={520}
      open={open}
      onClose={onClose}
      extra={
        <Button size="small" icon={<RotateCw className="size-3.5" />} onClick={() => void recordsQuery.refetch()} loading={recordsQuery.isFetching}>
          刷新
        </Button>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="shrink-0 text-xs text-stone-500 dark:text-stone-400">按角色筛选</span>
        <Select
          value={agentFilter}
          onChange={(value) => {
            onAgentFilterChange(value);
            onPageChange(1);
          }}
          options={agentOptions}
          className="!flex-1"
          placeholder="选择角色"
          showSearch
          optionFilterProp="label"
        />
      </div>

      {recordsQuery.isLoading ? (
        <div className="flex h-32 items-center justify-center text-sm text-stone-500">正在加载…</div>
      ) : records.length === 0 ? (
        <Empty
          description={agentFilter ? "该角色还没有生成记录" : "角色工作台还没有生成记录"}
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {records.map((record) => (
            <AgentRecordRow key={record.id} record={record} agent={record.agentId ? agentMap.get(record.agentId) : undefined} />
          ))}
        </div>
      )}

      {total > PAGE_SIZE ? (
        <div className="mt-4 flex justify-center">
          <Pagination
            size="small"
            current={page}
            total={total}
            pageSize={PAGE_SIZE}
            onChange={onPageChange}
            showSizeChanger={false}
          />
        </div>
      ) : null}
    </Drawer>
  );
}

function AgentRecordRow({ record, agent }: { record: GenerationRecord; agent?: Agent }) {
  const thumb = record.thumbnails[0];
  return (
    <Link
      href={`/image/${record.id}`}
      target="_blank"
      className="group flex gap-3 rounded-lg border border-stone-200 bg-card p-2.5 transition hover:border-blue-300 hover:bg-blue-50/40 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"
    >
      {/* 缩略图：成功记录用结果图，失败 / 缺失走占位 */}
      <div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-md bg-stone-100 dark:bg-stone-800">
        {thumb ? (
          <img src={imageUrl(thumb)} alt="" className="size-full object-cover" />
        ) : (
          <ImageIcon className="size-5 text-stone-400" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          {agent ? (
            <>
              <AgentAvatar name={agent.name} avatarUrl={agent.avatarUrl} size={18} />
              <span className="truncate text-sm font-medium">{agent.name}</span>
            </>
          ) : (
            <span className="truncate text-sm font-medium text-stone-500">已删除的角色</span>
          )}
          <StatusTag status={record.status} />
        </div>
        <div className="line-clamp-2 text-xs leading-4 text-stone-500 dark:text-stone-400">{record.prompt}</div>
        <div className="flex items-center gap-2 text-[11px] text-stone-400 dark:text-stone-500">
          <span>{formatLocalDateTime(record.createdAt)}</span>
          {record.durationMs ? <span>· {formatDuration(record.durationMs)}</span> : null}
          <span className="ml-auto inline-flex items-center gap-0.5 text-blue-500 opacity-0 transition group-hover:opacity-100">
            打开 <ExternalLink className="size-3" />
          </span>
        </div>
      </div>
    </Link>
  );
}

function StatusTag({ status }: { status: GenerationRecord["status"] }) {
  if (status === "running") return <Tag color="gold" className="m-0">进行中</Tag>;
  if (status === "failed") return <Tag color="red" className="m-0">失败</Tag>;
  if (status === "partial") return <Tag color="orange" className="m-0">部分</Tag>;
  return <Tag color="green" className="m-0">成功</Tag>;
}
