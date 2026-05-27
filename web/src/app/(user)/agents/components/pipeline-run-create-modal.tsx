"use client";

import { Play } from "lucide-react";
import { App, Button, Modal, Select, Tag } from "antd";
import { useEffect, useState } from "react";

import type { Agent } from "@/services/api/agents";
import type { Pipeline } from "@/services/api/pipelines";

import { AgentAvatar } from "./agent-avatar";
import { PipelineSeedCard } from "./pipeline-seed-card";

type Props = {
  open: boolean;
  pipelines: Pipeline[];
  agents: Agent[];
  submitting?: boolean;
  defaultPipelineId?: string;
  onSubmit: (payload: { pipelineId: string; seedKey: string }) => Promise<void> | void;
  onClose: () => void;
};

// 「+ 新增执行流程」Modal：选模板 + 上传 seed + 点「启动流水线」
export function PipelineRunCreateModal({ open, pipelines, agents, submitting, defaultPipelineId, onSubmit, onClose }: Props) {
  const { message } = App.useApp();
  const [pipelineId, setPipelineId] = useState<string>("");
  const [seedKey, setSeedKey] = useState<string>("");
  const [seedUrl, setSeedUrl] = useState<string>("");

  // 打开时初始化默认选中 + 清掉 seed
  useEffect(() => {
    if (!open) return;
    setPipelineId(defaultPipelineId || pipelines[0]?.id || "");
    setSeedKey("");
    setSeedUrl("");
  }, [open, defaultPipelineId, pipelines]);

  const selected = pipelines.find((item) => item.id === pipelineId) || null;
  const pipelineOptions = pipelines.map((item) => ({ label: `${item.name} · ${item.steps.length} 步`, value: item.id }));

  const start = async () => {
    if (!pipelineId) {
      message.warning("请选择一个流水线模板");
      return;
    }
    if (!seedKey) {
      message.warning("请上传原图");
      return;
    }
    await onSubmit({ pipelineId, seedKey });
  };

  return (
    <Modal
      title="新增执行流程"
      open={open}
      width={560}
      onCancel={onClose}
      footer={(
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" icon={<Play className="size-4" />} loading={submitting} onClick={() => void start()}>启动流水线</Button>
        </div>
      )}
      destroyOnHidden
    >
      <div className="flex flex-col gap-4">
        <div>
          <label className="mb-1 block text-sm font-semibold">选择流水线模板</label>
          {pipelines.length === 0 ? (
            <div className="rounded border border-dashed border-stone-300 p-3 text-xs text-stone-500 dark:border-stone-700">
              还没有任何流水线模板。请先点上方「+ 新建流水线」编排一条。
            </div>
          ) : (
            <Select
              value={pipelineId || undefined}
              options={pipelineOptions}
              onChange={setPipelineId}
              className="!w-full"
              placeholder="选择流水线模板"
            />
          )}
        </div>

        {selected ? (
          <div className="rounded-md border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900">
            <div className="mb-2 text-xs font-semibold text-stone-600 dark:text-stone-300">模板预览</div>
            <div className="flex flex-wrap gap-2">
              {selected.steps.map((step, index) => {
                const agent = agents.find((item) => item.id === step.agentId);
                return (
                  <div key={step.stepId} className="flex items-center gap-1.5 rounded-md bg-white px-2 py-1 text-xs dark:bg-stone-800">
                    <span className="grid size-4 place-items-center rounded-full bg-stone-100 text-[10px] font-semibold text-stone-700 dark:bg-stone-700 dark:text-stone-200">{index + 1}</span>
                    <AgentAvatar name={agent?.name || "?"} avatarUrl={agent?.avatarUrl} size={20} />
                    <span className="truncate">{agent?.name || <span className="text-red-500">已删除</span>}</span>
                  </div>
                );
              })}
            </div>
            {selected.description ? (
              <div className="mt-2 text-[11px] text-stone-500 dark:text-stone-400">{selected.description}</div>
            ) : null}
          </div>
        ) : null}

        <div>
          <label className="mb-1 block text-sm font-semibold">原图（流水线第一步的输入）</label>
          <PipelineSeedCard
            seedUrl={seedUrl}
            onChange={(next) => {
              if (!next) {
                setSeedKey("");
                setSeedUrl("");
                return;
              }
              setSeedKey(next.storageKey);
              setSeedUrl(next.url);
            }}
          />
          <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            原图会自动喂给第一步；每一步执行完产物会喂给下一步。
          </div>
        </div>
      </div>
    </Modal>
  );
}
