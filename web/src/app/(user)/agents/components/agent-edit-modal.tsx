"use client";

import { Image as ImageIcon, Plus, Trash2, Upload } from "lucide-react";
import { App, AutoComplete, Button, Form, Image, Input, Modal, Select } from "antd";
import { useEffect, useRef } from "react";

import { useImageUploader } from "@/lib/use-image-uploader";
import { imageUrl } from "@/services/image-storage";
import type { Agent } from "@/services/api/agents";

import { AgentAvatar } from "./agent-avatar";

const MAX_REFERENCE_IMAGES = 3;

type AgentFormValues = {
  name: string;
  description?: string;
  systemPrompt: string;
  defaultSize?: string;
  defaultQuality?: string;
  avatarUrl?: string;
  referenceImageKeys?: string[];
};

type AgentEditModalProps = {
  open: boolean;
  editing: Agent | null;
  onClose: () => void;
  onSubmit: (values: AgentFormValues) => Promise<void> | void;
  submitting?: boolean;
};

// 跟 /image 工作台保持一致的选项，避免心智割裂。
const sizeOptions = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"].map((value) => ({ label: value, value }));
const qualityOptions = ["auto", "low", "medium", "high"].map((value) => ({ label: value, value }));

export function AgentEditModal({ open, editing, onClose, onSubmit, submitting }: AgentEditModalProps) {
  const { message } = App.useApp();
  const [form] = Form.useForm<AgentFormValues>();
  const uploadWithToast = useImageUploader();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 全局共用一个隐藏的参考图 file input：上一次点哪个槽位（添加 / 替换），就把
  // index 存进 refSlotIndexRef，input 的 onChange 拿到 index 写回 form。
  // 这样既避免渲染多份 input 露出原生「选择文件 未选择…」UI，也省得每个槽位重写一遍 ref。
  const refFileInputRef = useRef<HTMLInputElement>(null);
  const refSlotIndexRef = useRef<number>(-1);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      name: editing?.name || "",
      description: editing?.description || "",
      systemPrompt: editing?.systemPrompt || "",
      defaultSize: editing?.defaultSize || "auto",
      defaultQuality: editing?.defaultQuality || "auto",
      avatarUrl: editing?.avatarUrl || "",
      referenceImageKeys: editing?.referenceImageKeys || [],
    });
  }, [open, editing, form]);

  const handleAvatarPick = async (file?: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      message.error("请上传图片格式的头像");
      return;
    }
    try {
      const result = await uploadWithToast(file, { label: "角色头像" });
      // 注意：uploadImage 返回的 result.url 是 ObjectURL，仅当前会话有效，落库后刷新就 404。
      // 这里统一存「/api/images/{storageKey}」的服务端直链，保证跨会话 / 跨浏览器都能加载。
      form.setFieldValue("avatarUrl", imageUrl(result.storageKey));
    } catch {
      // useImageUploader 已经弹错误 toast
    }
  };

  // 打开 file picker：传入 index，添加一张就用 current.length，替换某张就用对应 index。
  const openReferencePicker = (index: number) => {
    refSlotIndexRef.current = index;
    refFileInputRef.current?.click();
  };

  // 设置 / 替换某个 index 上的参考图：
  //   - index 等于现有长度时，等于「新增一张」追加
  //   - index < 长度时，等于「替换那一张」
  const handleReferenceSlot = async (index: number, file?: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      message.error("请上传图片文件");
      return;
    }
    const current: string[] = form.getFieldValue("referenceImageKeys") || [];
    if (index >= MAX_REFERENCE_IMAGES) return;
    try {
      const result = await uploadWithToast(file, { label: "参考图" });
      const next = [...current];
      next[index] = result.storageKey;
      // 去空 + 截断到上限，避免出现非连续空槽
      form.setFieldValue("referenceImageKeys", next.filter(Boolean).slice(0, MAX_REFERENCE_IMAGES));
    } catch {
      // useImageUploader 已弹错误
    }
  };

  const removeReference = (index: number) => {
    const current: string[] = form.getFieldValue("referenceImageKeys") || [];
    form.setFieldValue("referenceImageKeys", current.filter((_, idx) => idx !== index));
  };

  const submit = async () => {
    const values = await form.validateFields();
    await onSubmit(values);
  };

  const watchedName = Form.useWatch("name", form) || "";
  const watchedAvatar = Form.useWatch("avatarUrl", form) || "";
  const watchedReferenceKeys: string[] = Form.useWatch("referenceImageKeys", form) || [];

  return (
    <Modal
      title={editing ? "编辑角色" : "新建角色"}
      open={open}
      onCancel={onClose}
      onOk={() => void submit()}
      okText="保存"
      cancelText="取消"
      confirmLoading={submitting}
      width={640}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" requiredMark={false} className="mt-3">
        <Form.Item label="头像">
          <div className="flex items-center gap-3">
            <AgentAvatar name={watchedName} avatarUrl={watchedAvatar} size={56} />
            <div className="flex flex-col gap-1">
              <div className="flex gap-2">
                <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>上传头像</Button>
                {watchedAvatar ? (
                  <Button size="small" type="text" onClick={() => form.setFieldValue("avatarUrl", "")}>用名字首字</Button>
                ) : null}
              </div>
              <span className="text-xs text-stone-500 dark:text-stone-400">不上传则用名字首字 + 自动配色作为头像</span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                void handleAvatarPick(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
        </Form.Item>
        <Form.Item name="avatarUrl" hidden><Input /></Form.Item>
        <Form.Item name="name" label="角色名" rules={[{ required: true, message: "请输入角色名" }, { max: 20, message: "角色名最多 20 个字" }]}>
          <Input placeholder="例如：白底图工人" />
        </Form.Item>
        <Form.Item name="description" label="角色描述（一行）" rules={[{ max: 80, message: "描述最多 80 个字" }]}>
          <Input placeholder="可写：能做什么、效果特点、适用场景" />
        </Form.Item>
        <Form.Item
          name="systemPrompt"
          label="系统提示词"
          rules={[{ required: true, message: "请输入系统提示词" }, { max: 4000, message: "最多 4000 字" }]}
          extra="工作台调用这个角色时会自动作为提示词使用，用户每次只需要上传图片，无需重复写提示词。"
        >
          <Input.TextArea rows={6} placeholder="例如：你是一个商品白底图大师，请抠出主体并将背景换成纯白色，保持原始光影与细节。" />
        </Form.Item>
        <Form.Item
          label={`参考图（可选，最多 ${MAX_REFERENCE_IMAGES} 张）`}
          extra="不传也可以；如果加了，每次该角色生图都会和你在工作台上传的图一起作为参考。常用于「按这种风格 / 构图来」类的角色。"
        >
          <div className="flex flex-wrap items-start gap-3">
            {watchedReferenceKeys.map((key, index) => (
              <div key={`${index}-${key}`} className="group relative size-[104px] overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                <Image
                  src={imageUrl(key)}
                  alt={`参考图 ${index + 1}`}
                  width={104}
                  height={104}
                  className="!size-[104px] object-cover"
                  preview={{ mask: "查看" }}
                />
                <div className="absolute inset-x-0 bottom-0 hidden items-center justify-end gap-1 bg-gradient-to-t from-black/70 to-transparent p-1.5 group-hover:flex">
                  <Button size="small" icon={<Upload className="size-3" />} onClick={() => openReferencePicker(index)}>换</Button>
                  <Button size="small" type="primary" danger icon={<Trash2 className="size-3" />} onClick={() => removeReference(index)}>删</Button>
                </div>
              </div>
            ))}
            {watchedReferenceKeys.length < MAX_REFERENCE_IMAGES ? (
              <button
                type="button"
                onClick={() => openReferencePicker(watchedReferenceKeys.length)}
                className="grid size-[104px] place-items-center rounded-md border border-dashed border-stone-300 bg-stone-50 text-stone-500 transition hover:border-blue-400 hover:text-blue-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400"
              >
                <div className="flex flex-col items-center gap-1">
                  <Plus className="size-5" />
                  <span className="text-xs">添加参考图</span>
                </div>
              </button>
            ) : null}
            {watchedReferenceKeys.length === 0 ? (
              <div className="flex h-[104px] items-center text-xs text-stone-500 dark:text-stone-400">
                <ImageIcon className="mr-1 size-3.5" />
                <span>没有参考图也能生成，调用时只走你在工作台上传的图</span>
              </div>
            ) : null}
          </div>
        </Form.Item>
        <Form.Item name="referenceImageKeys" hidden>
          <Input />
        </Form.Item>
        <input
          ref={refFileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            const index = refSlotIndexRef.current;
            refSlotIndexRef.current = -1;
            if (index >= 0) void handleReferenceSlot(index, event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <div className="grid grid-cols-2 gap-3">
          <Form.Item name="defaultSize" label="默认尺寸">
            <AutoComplete options={sizeOptions} placeholder="auto" />
          </Form.Item>
          <Form.Item name="defaultQuality" label="默认质量">
            <Select options={qualityOptions} />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}

export type { AgentFormValues };
