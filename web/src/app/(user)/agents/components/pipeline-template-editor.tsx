"use client";

import { Plus } from "lucide-react";
import { Button, Form, Input } from "antd";
import { useEffect } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { createId } from "@/lib/id";
import type { Agent } from "@/services/api/agents";

import { PipelineTemplateStepCard, type TemplateStepDraft } from "./pipeline-template-step-card";

const MAX_STEPS = 10;

export type TemplateDraft = {
  name: string;
  description: string;
  steps: TemplateStepDraft[];
};

type Props = {
  // 受控草稿：父组件管 state，编辑器只做交互 + 触发 onChange
  draft: TemplateDraft;
  onChange: (next: TemplateDraft) => void;
  agents: Agent[];
};

// 流水线模板编辑器：名字 / 描述 / 步骤列表（可拖拽换序、增删、改角色、改附加说明）。
// 用在「+ 新建流水线」/ 「编辑流水线」Modal 里。不包含 seed / 执行 —— 那是 run 的事。
export function PipelineTemplateEditor({ draft, onChange, agents }: Props) {
  const [form] = Form.useForm<{ name: string; description: string }>();

  useEffect(() => {
    form.setFieldsValue({ name: draft.name, description: draft.description });
  }, [draft.name, draft.description, form]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const updateName = (next: string) => onChange({ ...draft, name: next });
  const updateDescription = (next: string) => onChange({ ...draft, description: next });
  const updateSteps = (mapper: (steps: TemplateStepDraft[]) => TemplateStepDraft[]) => onChange({ ...draft, steps: mapper(draft.steps) });

  const handleAddStep = () => {
    if (draft.steps.length >= MAX_STEPS) return;
    if (!agents.length) return;
    updateSteps((steps) => [...steps, { stepId: createId(), agentId: agents[0].id, extraNote: "" }]);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    updateSteps((steps) => {
      const oldIndex = steps.findIndex((item) => item.stepId === active.id);
      const newIndex = steps.findIndex((item) => item.stepId === over.id);
      if (oldIndex < 0 || newIndex < 0) return steps;
      return arrayMove(steps, oldIndex, newIndex);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="name" label="流水线名称" rules={[{ required: true, message: "请输入名称" }, { max: 30, message: "名称最多 30 个字" }]}>
          <Input placeholder="例如：电商三件套 - 白底 + 模特 + 精修" onChange={(event) => updateName(event.target.value)} />
        </Form.Item>
        <Form.Item name="description" label="描述（可选）" rules={[{ max: 80, message: "描述最多 80 个字" }]}>
          <Input placeholder="一句话说明这条流水线适合做什么" onChange={(event) => updateDescription(event.target.value)} />
        </Form.Item>
      </Form>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-stone-700 dark:text-stone-200">步骤编排（{draft.steps.length}/{MAX_STEPS}）</h3>
        <span className="text-xs text-stone-400">拖动 grip 把手调整顺序</span>
      </div>

      {!agents.length ? (
        <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-stone-300 text-sm text-stone-500 dark:border-stone-700">
          还没有角色，请先到左侧「我的角色」新建几个再来编排流水线
        </div>
      ) : draft.steps.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-stone-300 p-6 text-sm text-stone-500 dark:border-stone-700">
          <p>还没有步骤，点下方按钮添加第一步</p>
          <Button type="primary" icon={<Plus className="size-4" />} onClick={handleAddStep}>添加第一步</Button>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={draft.steps.map((step) => step.stepId)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-2">
              {draft.steps.map((step, index) => (
                <PipelineTemplateStepCard
                  key={step.stepId}
                  index={index}
                  step={step}
                  agents={agents}
                  onChangeAgent={(agentId) => updateSteps((steps) => steps.map((item, idx) => (idx === index ? { ...item, agentId } : item)))}
                  onChangeExtraNote={(extraNote) => updateSteps((steps) => steps.map((item, idx) => (idx === index ? { ...item, extraNote } : item)))}
                  onRemove={() => updateSteps((steps) => steps.filter((_, idx) => idx !== index))}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {agents.length && draft.steps.length > 0 && draft.steps.length < MAX_STEPS ? (
        <Button icon={<Plus className="size-4" />} onClick={handleAddStep} className="self-start">添加步骤</Button>
      ) : null}
    </div>
  );
}
