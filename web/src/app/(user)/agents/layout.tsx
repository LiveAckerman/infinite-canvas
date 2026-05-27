"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { RequireAuth } from "@/components/require-auth";
import { fetchMyAgents } from "@/services/api/agents";
import { useUserStore } from "@/stores/use-user-store";

import { PipelineRunManagerProvider } from "./components/pipeline-run-manager-context";

const AGENTS_QUERY_KEY = ["my-agents"] as const;

// /agents 整段路由的共享外壳：
//   - RequireAuth 守卫
//   - 拉一次 agents（react-query 缓存让子页面 useQuery 同 key 直接复用）
//   - 把 RunManager 用 Provider 挂上去 —— 这样 / 跟 /runs/[id] 同一个调度器实例，
//     用户从列表点进详情、再返回，跑中的 run 不会因为页面切换被中断。
export default function AgentsLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <AgentsRoot>{children}</AgentsRoot>
    </RequireAuth>
  );
}

function AgentsRoot({ children }: { children: ReactNode }) {
  const token = useUserStore((state) => state.token);
  const agentsQuery = useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: () => fetchMyAgents(token),
    enabled: Boolean(token),
  });
  const agents = agentsQuery.data?.items || [];
  return (
    <PipelineRunManagerProvider agents={agents}>
      {children}
    </PipelineRunManagerProvider>
  );
}
