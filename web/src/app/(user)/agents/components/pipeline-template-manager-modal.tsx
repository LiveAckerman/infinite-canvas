"use client";

import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { App, Button, Empty, Modal, Tag, Typography } from "antd";

import type { Agent } from "@/services/api/agents";
import type { Pipeline } from "@/services/api/pipelines";

type Props = {
  open: boolean;
  pipelines: Pipeline[];
  agents: Agent[];
  loading?: boolean;
  onClose: () => void;
  onNew: () => void;
  onEdit: (pipeline: Pipeline) => void;
  onDuplicate: (pipeline: Pipeline) => void;
  onDelete: (pipeline: Pipeline) => void;
};

// 「管理流水线模板」Modal：表格 / 列表展示所有模板 + 行内操作。
// 入口在 /agents 流水线 Tab 顶部的小按钮。新建走单独 Modal（PipelineTemplateModal）。
export function PipelineTemplateManagerModal({ open, pipelines, agents, loading, onClose, onNew, onEdit, onDuplicate, onDelete }: Props) {
  const { modal } = App.useApp();

  const confirmDelete = (pipeline: Pipeline) => {
    modal.confirm({
      title: "删除流水线模板",
      content: `确定删除「${pipeline.name}」吗？已经基于这个模板发起的执行流程不会被删，但下次新建执行流程时将看不到这个模板。`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => onDelete(pipeline),
    });
  };

  return (
    <Modal
      title="流水线模板"
      open={open}
      width={680}
      onCancel={onClose}
      footer={(
        <div className="flex justify-between">
          <Button type="primary" icon={<Plus className="size-4" />} onClick={onNew}>新建流水线</Button>
          <Button onClick={onClose}>关闭</Button>
        </div>
      )}
      destroyOnHidden
    >
      {loading ? (
        <div className="flex h-32 items-center justify-center text-sm text-stone-500">加载中…</div>
      ) : pipelines.length === 0 ? (
        <Empty description="还没有任何流水线模板" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div className="flex flex-col gap-2">
          {pipelines.map((pipeline) => {
            const missingAgentCount = pipeline.steps.filter((step) => !agents.some((agent) => agent.id === step.agentId)).length;
            return (
              <div
                key={pipeline.id}
                className="flex items-start gap-3 rounded-lg border border-stone-200 p-3 transition hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Typography.Text strong className="!text-sm">{pipeline.name}</Typography.Text>
                    <Tag color="blue" className="m-0">{pipeline.steps.length} 步</Tag>
                    {missingAgentCount > 0 ? <Tag color="red" className="m-0">{missingAgentCount} 个角色已删</Tag> : null}
                  </div>
                  {pipeline.description ? (
                    <Typography.Text type="secondary" className="!text-xs">{pipeline.description}</Typography.Text>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="small" type="text" icon={<Pencil className="size-3.5" />} onClick={() => onEdit(pipeline)}>编辑</Button>
                  <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => onDuplicate(pipeline)}>复制</Button>
                  <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} onClick={() => confirmDelete(pipeline)}>删除</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
