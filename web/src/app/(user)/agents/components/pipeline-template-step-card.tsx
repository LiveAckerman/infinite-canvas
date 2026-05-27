"use client";

import { GripVertical, X } from "lucide-react";
import { Input, Select, Tag } from "antd";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { Agent } from "@/services/api/agents";

import { AgentAvatar } from "./agent-avatar";

export type TemplateStepDraft = {
  stepId: string;
  agentId: string;
  extraNote: string;
};

type Props = {
  index: number;
  step: TemplateStepDraft;
  agents: Agent[];
  onChangeAgent: (agentId: string) => void;
  onChangeExtraNote: (extraNote: string) => void;
  onRemove: () => void;
  disabled?: boolean;
};

// 流水线模板编辑器里的「步骤卡」精简版：
// 只编辑「角色 + 附加说明」，不展示输入图 / 输出图 / 状态 —— 这些都是 run 实例的概念，模板里没有。
// 区别于 PipelineStepCard（用于 run 详情）：那个有 input/output/重做按钮。
export function PipelineTemplateStepCard({ index, step, agents, onChangeAgent, onChangeExtraNote, onRemove, disabled }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: step.stepId, disabled });
  const draggingStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.7 : undefined,
  };
  const agent = agents.find((item) => item.id === step.agentId) || null;
  const agentOptions = agents.map((item) => ({ label: item.name, value: item.id }));

  return (
    <div
      ref={setNodeRef}
      style={draggingStyle}
      className="flex w-full items-start gap-3 rounded-lg border border-stone-200 bg-card p-3 dark:border-stone-800"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        disabled={disabled}
        className={`mt-1 grid size-7 shrink-0 cursor-grab place-items-center rounded text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 active:cursor-grabbing dark:hover:bg-stone-800 dark:hover:text-stone-200 ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
        title="拖动调整顺序"
        aria-label="拖动调整顺序"
      >
        <GripVertical className="size-4" />
      </button>
      <span className="mt-1 grid size-7 shrink-0 place-items-center rounded-full bg-stone-100 text-xs font-semibold text-stone-700 dark:bg-stone-800 dark:text-stone-200">{index + 1}</span>
      <AgentAvatar name={agent?.name || "?"} avatarUrl={agent?.avatarUrl} size={32} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Select
          size="middle"
          value={step.agentId}
          options={agentOptions}
          onChange={onChangeAgent}
          disabled={disabled}
          className="!w-full"
          placeholder="选择角色"
          notFoundContent="还没有角色，请先去新建"
        />
        <Input.TextArea
          value={step.extraNote}
          onChange={(event) => onChangeExtraNote(event.target.value)}
          placeholder="附加说明（可选）—— 拼在角色系统提示词后面"
          rows={2}
          disabled={disabled}
        />
        {agent?.referenceImageKeys?.length ? (
          <Tag className="m-0 w-fit text-[11px]" color="blue">该角色自带 {agent.referenceImageKeys.length} 张参考图</Tag>
        ) : null}
      </div>
      <button
        type="button"
        disabled={disabled}
        className="grid size-7 shrink-0 place-items-center rounded text-stone-400 transition hover:bg-red-50 hover:text-red-500 disabled:opacity-40 dark:hover:bg-red-950/30"
        onClick={onRemove}
        aria-label="删除该步骤"
        title="删除该步骤"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
