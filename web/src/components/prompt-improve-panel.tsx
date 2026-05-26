"use client";

import { App, Button } from "antd";
import { Check, RotateCw, Sparkles, X } from "lucide-react";
import { useState } from "react";

import { improvePrompt } from "@/services/api/prompts-improve";
import { useUserStore } from "@/stores/use-user-store";
import { cn } from "@/lib/utils";

type PromptImproveBarProps = {
  // 取当前提示词文本（点优化时调用）
  getPrompt: () => string;
  // 用户点「接受」时把优化后的文本写回提示词
  onAccept: (improved: string) => void;
  // 容器额外 className，可控宽度 / 对齐
  className?: string;
  // 触发按钮额外 className，方便嵌入工具栏
  triggerClassName?: string;
  // 整个组件禁用（比如 generate 跑中）
  disabled?: boolean;
};

// PromptImproveBar 是一个可嵌入提示词输入框附近的小工具栏：
// 触发按钮：点击 → 调后端反代 → 在下方原地显示「优化后的版本 + 接受 / 重试 / 拒绝」
// 不用 Modal；接受才覆盖；拒绝就丢弃；重试再调一次（基于原 prompt，不是优化后的）。
export function PromptImproveBar({ getPrompt, onAccept, className, triggerClassName, disabled }: PromptImproveBarProps) {
  const { message } = App.useApp();
  const token = useUserStore((state) => state.token);
  const [loading, setLoading] = useState(false);
  const [original, setOriginal] = useState("");
  const [improved, setImproved] = useState("");

  const run = async (forPrompt: string) => {
    if (!forPrompt.trim()) {
      message.error("请先输入需要优化的提示词");
      return;
    }
    if (!token) {
      message.error("请先登录");
      return;
    }
    setLoading(true);
    try {
      const result = await improvePrompt(token, forPrompt);
      setOriginal(forPrompt);
      setImproved(result);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "提示词优化失败");
    } finally {
      setLoading(false);
    }
  };

  const handleTrigger = () => {
    void run(getPrompt());
  };

  const handleRetry = () => {
    if (!original) return;
    void run(original);
  };

  const handleAccept = () => {
    if (!improved) return;
    onAccept(improved);
    setOriginal("");
    setImproved("");
    message.success("已采用优化后的提示词");
  };

  const handleReject = () => {
    setOriginal("");
    setImproved("");
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex justify-end">
        <Button
          size="small"
          icon={<Sparkles className="size-3.5" />}
          loading={loading}
          disabled={disabled}
          onClick={handleTrigger}
          className={triggerClassName}
        >
          AI 优化
        </Button>
      </div>

      {improved ? (
        <div className="rounded-md border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900/50 dark:bg-blue-950/30">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium text-blue-700 dark:text-blue-300">
            <span className="inline-flex items-center gap-1"><Sparkles className="size-3" />优化后版本（仅预览，未应用）</span>
            <div className="flex items-center gap-1">
              <Button size="small" type="text" icon={<RotateCw className="size-3" />} loading={loading} onClick={handleRetry} title="基于原文重新优化">重试</Button>
              <Button size="small" type="text" danger icon={<X className="size-3" />} onClick={handleReject} title="放弃优化结果">拒绝</Button>
              <Button size="small" type="primary" icon={<Check className="size-3" />} onClick={handleAccept}>接受并替换</Button>
            </div>
          </div>
          <pre className="thin-scrollbar max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-stone-800 dark:text-stone-100" style={{ fontFamily: "inherit" }}>{improved}</pre>
        </div>
      ) : null}
    </div>
  );
}
