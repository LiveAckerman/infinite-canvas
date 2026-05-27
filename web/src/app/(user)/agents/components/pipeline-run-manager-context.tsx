"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { Agent } from "@/services/api/agents";

import { usePipelineRunManager } from "../hooks/use-pipeline-run-manager";

type Manager = ReturnType<typeof usePipelineRunManager>;

const Ctx = createContext<Manager | null>(null);

// 把 RunManager 作为「整页单例」挂到 Context，列表页和详情页都从这里取，
// 避免每个页面各自挂一份导致同一 tab 出现 2 个调度器 / cap 失效。
export function PipelineRunManagerProvider({ agents, children }: { agents: Agent[]; children: ReactNode }) {
  const manager = usePipelineRunManager({ agents });
  return <Ctx.Provider value={manager}>{children}</Ctx.Provider>;
}

export function usePipelineRunManagerCtx(): Manager {
  const value = useContext(Ctx);
  if (!value) throw new Error("usePipelineRunManagerCtx 必须在 PipelineRunManagerProvider 之下使用");
  return value;
}
