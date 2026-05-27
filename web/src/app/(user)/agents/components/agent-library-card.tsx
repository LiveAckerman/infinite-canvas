"use client";

import { Copy, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, Dropdown, type MenuProps } from "antd";

import type { Agent } from "@/services/api/agents";
import { imageUrl } from "@/services/image-storage";
import { cn } from "@/lib/utils";

import { AgentAvatar } from "./agent-avatar";

type AgentLibraryCardProps = {
  agent: Agent;
  inWorkspace: boolean;
  onAddToWorkspace: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  // 「+ 加入工作区」按钮只有并行模式下有意义；流水线模式下走步骤卡的角色 Select，
  // 不需要这个按钮，传 false 隐藏。
  showAddToWorkspace?: boolean;
};

// 「我的角色」库里的紧凑卡片：头像 + 名字 + 描述 + 已用 N 次 + ⋯ 菜单 + 加入工作区按钮。
export function AgentLibraryCard({ agent, inWorkspace, onAddToWorkspace, onEdit, onDuplicate, onDelete, showAddToWorkspace = true }: AgentLibraryCardProps) {
  const menuItems: MenuProps["items"] = [
    { key: "edit", icon: <Pencil className="size-4" />, label: "编辑", onClick: onEdit },
    { key: "duplicate", icon: <Copy className="size-4" />, label: "复制一个", onClick: onDuplicate },
    { type: "divider" },
    { key: "delete", icon: <Trash2 className="size-4" />, label: "删除", danger: true, onClick: onDelete },
  ];

  return (
    <div
      className={cn(
        "group relative flex w-full flex-col gap-2 rounded-lg border border-stone-200 bg-card p-3 transition hover:shadow-sm dark:border-stone-800",
        inWorkspace ? "ring-1 ring-blue-400 dark:ring-blue-500" : null,
      )}
    >
      <div className="flex items-start gap-2.5">
        <AgentAvatar name={agent.name} avatarUrl={agent.avatarUrl} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold leading-5">{agent.name}</span>
            {agent.referenceImageKeys?.length ? (
              <div className="flex shrink-0 -space-x-1.5" title={`角色带 ${agent.referenceImageKeys.length} 张参考图`}>
                {agent.referenceImageKeys.slice(0, 3).map((key) => (
                  <img
                    key={key}
                    src={imageUrl(key)}
                    alt="参考图"
                    className="size-4 rounded-sm border border-white object-cover dark:border-stone-900"
                  />
                ))}
              </div>
            ) : null}
          </div>
          <div className="line-clamp-2 min-h-[32px] text-xs leading-4 text-stone-500 dark:text-stone-400">{agent.description || "未填写描述"}</div>
        </div>
        <Dropdown menu={{ items: menuItems }} trigger={["click"]} placement="bottomRight">
          <button
            type="button"
            onClick={(event) => event.stopPropagation()}
            className="grid size-7 shrink-0 place-items-center rounded text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200"
            aria-label="更多操作"
            title="更多操作"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </Dropdown>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-stone-400 dark:text-stone-500">已用 {agent.usageCount || 0} 次</span>
        {showAddToWorkspace ? (
          <Button
            size="small"
            type={inWorkspace ? "default" : "primary"}
            disabled={inWorkspace}
            icon={<Plus className="size-3.5" />}
            onClick={onAddToWorkspace}
          >
            {inWorkspace ? "已加入" : "加入工作区"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
