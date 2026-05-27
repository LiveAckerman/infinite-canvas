"use client";

import { App, Modal } from "antd";
import { useEffect, useMemo, useState } from "react";

import { createId } from "@/lib/id";
import type { Agent } from "@/services/api/agents";
import type { Pipeline } from "@/services/api/pipelines";

import { PipelineTemplateEditor, type TemplateDraft } from "./pipeline-template-editor";

type Props = {
  open: boolean;
  editing: Pipeline | null;  // null = 新建
  agents: Agent[];
  submitting?: boolean;
  onSubmit: (draft: TemplateDraft) => Promise<void> | void;
  onClose: () => void;
};

// 空草稿。新建场景默认给一个 stepId 占位的空数组，让用户从「+添加第一步」开始。
const EMPTY: TemplateDraft = { name: "", description: "", steps: [] };

// 包装 Modal：标题切「新建 / 编辑」，关闭时检测 dirty 弹二次确认。
// 用户点 OK 走 onSubmit，调用方做异步保存后再 onClose。
export function PipelineTemplateModal({ open, editing, agents, submitting, onSubmit, onClose }: Props) {
  const { modal } = App.useApp();

  // 把 Pipeline 转 TemplateDraft（保留原 stepId 不再生成新的，确保前后端一致 / DnD key 稳定）
  const initial = useMemo<TemplateDraft>(() => {
    if (!editing) return EMPTY;
    return {
      name: editing.name,
      description: editing.description,
      steps: editing.steps.map((step) => ({
        stepId: step.stepId || createId(),
        agentId: step.agentId,
        extraNote: step.extraNote,
      })),
    };
  }, [editing]);

  const [draft, setDraft] = useState<TemplateDraft>(initial);

  // open 切换时把 draft 重置为 initial（编辑别人 / 关掉再打开都要刷）
  useEffect(() => {
    if (open) setDraft(initial);
  }, [open, initial]);

  const dirty = useMemo(() => {
    if (draft.name !== initial.name) return true;
    if (draft.description !== initial.description) return true;
    if (draft.steps.length !== initial.steps.length) return true;
    return draft.steps.some((step, index) => (
      step.stepId !== initial.steps[index].stepId
      || step.agentId !== initial.steps[index].agentId
      || step.extraNote !== initial.steps[index].extraNote
    ));
  }, [draft, initial]);

  const tryClose = () => {
    if (!dirty) {
      onClose();
      return;
    }
    modal.confirm({
      title: "丢弃未保存修改？",
      content: "你对流水线的改动还没保存，确定关闭并丢弃？",
      okText: "丢弃并关闭",
      okButtonProps: { danger: true },
      cancelText: "继续编辑",
      onOk: () => onClose(),
    });
  };

  const trySubmit = async () => {
    if (!draft.name.trim()) {
      modal.warning({ title: "请输入流水线名称" });
      return;
    }
    if (draft.steps.length === 0) {
      modal.warning({ title: "请至少添加 1 个步骤" });
      return;
    }
    await onSubmit({
      name: draft.name.trim(),
      description: draft.description.trim(),
      steps: draft.steps,
    });
  };

  return (
    <Modal
      title={editing ? "编辑流水线" : "新建流水线"}
      open={open}
      width={720}
      maskClosable={false}
      keyboard={false}
      onCancel={tryClose}
      onOk={() => void trySubmit()}
      okText="保存"
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnHidden
    >
      <PipelineTemplateEditor draft={draft} onChange={setDraft} agents={agents} />
    </Modal>
  );
}
