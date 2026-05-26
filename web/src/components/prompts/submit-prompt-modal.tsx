"use client";

import { App, Button, Form, Input, Modal, Radio, Space, Tag } from "antd";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { imageUrl } from "@/services/image-storage";
import { submitPrompt } from "@/services/api/prompts";
import { useUserStore } from "@/stores/use-user-store";

const TAG_MAX_LEN = 6;
const TITLE_MAX_LEN = 30;

type FormValues = {
  title: string;
  prompt: string;
  category: string;
  tags: string[];
};

type SubmitPromptModalProps = {
  open: boolean;
  onClose: () => void;
  defaultPrompt: string;
  // 可选效果图：通常是 record.thumbnails（image storageKey 列表）
  imageOptions: string[];
};

export function SubmitPromptModal({ open, onClose, defaultPrompt, imageOptions }: SubmitPromptModalProps) {
  const { message } = App.useApp();
  const token = useUserStore((state) => state.token);
  const [form] = Form.useForm<FormValues>();
  const [selectedCover, setSelectedCover] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      title: "",
      prompt: defaultPrompt,
      category: "system",
      tags: [],
    });
    setSelectedCover(imageOptions[0] || "");
  }, [defaultPrompt, form, imageOptions, open]);

  const handleSubmit = async () => {
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    if (!selectedCover) {
      message.error("请选择一张效果图");
      return;
    }
    const tooLongTag = values.tags.find((tag) => Array.from(tag.trim()).length > TAG_MAX_LEN);
    if (tooLongTag) {
      message.error(`标签「${tooLongTag}」超过 ${TAG_MAX_LEN} 个字`);
      return;
    }
    setSubmitting(true);
    try {
      await submitPrompt(token, {
        title: values.title.trim(),
        prompt: values.prompt.trim(),
        category: values.category.trim() || "system",
        tags: values.tags.map((t) => t.trim()).filter(Boolean),
        coverImageId: selectedCover,
      });
      message.success("已提交至提示词库，待管理员审核通过后即可在前台展示");
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={handleSubmit}
      title={<Space size={6}><Sparkles className="size-4" />加入提示词库</Space>}
      okText="提交审核"
      okButtonProps={{ loading: submitting }}
      width={620}
      destroyOnHidden
    >
      <Form layout="vertical" form={form} requiredMark={false}>
        <Form.Item
          name="title"
          label="标题"
          rules={[
            { required: true, message: "请输入标题" },
            { max: TITLE_MAX_LEN, message: `标题最多 ${TITLE_MAX_LEN} 个字` },
          ]}
        >
          <Input placeholder="例如：街拍人像 - 复古色调" maxLength={TITLE_MAX_LEN} showCount />
        </Form.Item>

        <Form.Item label="效果图（必选 1 张）">
          {imageOptions.length === 0 ? (
            <div className="rounded-md border border-dashed border-stone-300 px-3 py-4 text-center text-sm text-stone-500 dark:border-stone-700">
              这条记录没有可用的生成结果，无法提交
            </div>
          ) : (
            <Radio.Group
              value={selectedCover}
              onChange={(event) => setSelectedCover(event.target.value)}
              className="!flex !flex-wrap !gap-2"
            >
              {imageOptions.map((id) => (
                <Radio key={id} value={id} className="!m-0">
                  <span className="inline-block">
                    <img
                      src={imageUrl(id)}
                      alt="cover-option"
                      className="size-20 rounded-md border border-stone-200 object-cover dark:border-stone-800"
                      style={{ outline: selectedCover === id ? "2px solid #2563eb" : "none" }}
                    />
                  </span>
                </Radio>
              ))}
            </Radio.Group>
          )}
        </Form.Item>

        <Form.Item name="category" label="分类" tooltip="默认 system，可改成其他分类编码">
          <Input placeholder="system" />
        </Form.Item>

        <Form.Item name="tags" label={`标签（每个最多 ${TAG_MAX_LEN} 个字，最多 8 个）`}>
          <PromptTagSelector />
        </Form.Item>

        <Form.Item
          name="prompt"
          label="提示词内容"
          rules={[{ required: true, message: "请填写提示词" }]}
        >
          <Input.TextArea rows={5} maxLength={4000} showCount />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// 简易 tag 输入：antd Select mode="tags" 即可，但 6 字限制要在 onChange 拦截。
function PromptTagSelector({ value, onChange }: { value?: string[]; onChange?: (next: string[]) => void }) {
  const { message } = App.useApp();
  const [input, setInput] = useState("");
  const tags = value || [];

  const commit = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (Array.from(trimmed).length > TAG_MAX_LEN) {
      message.error(`「${trimmed}」超过 ${TAG_MAX_LEN} 个字`);
      return;
    }
    if (tags.includes(trimmed)) {
      setInput("");
      return;
    }
    if (tags.length >= 8) {
      message.error("标签最多 8 个");
      return;
    }
    onChange?.([...tags, trimmed]);
    setInput("");
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {tags.map((tag) => (
        <Tag key={tag} closable onClose={() => onChange?.(tags.filter((t) => t !== tag))} color="blue">{tag}</Tag>
      ))}
      <Input
        size="small"
        style={{ width: 140 }}
        placeholder="输入后回车添加"
        value={input}
        onChange={(event) => setInput(event.target.value.slice(0, TAG_MAX_LEN))}
        onPressEnter={commit}
        onBlur={commit}
        maxLength={TAG_MAX_LEN}
      />
      {tags.length === 0 ? <Button size="small" type="link" onClick={commit} disabled={!input.trim()}>添加</Button> : null}
    </div>
  );
}
