"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { RequireAuth } from "@/components/require-auth";
import { fetchMyAgents } from "@/services/api/agents";
import { fetchMyPipelineRuns, type PipelineRunListResponse } from "@/services/api/pipeline-runs";
import { useUserStore } from "@/stores/use-user-store";

import { PipelineRunManagerProvider } from "./components/pipeline-run-manager-context";
import { RUNS_QUERY_KEY } from "./hooks/use-pipeline-run-manager";

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
  // 全局拉一次「我的全部 runs」放到 RUNS_QUERY_KEY cache 里，让调度器能始终看到。
  // 如果用户停在「批量任务」Tab / batch detail 页，本来这两个页面只 fetch batch detail
  // （查的是 ["my-pipeline-batch", id]），不会自动填充 RUNS_QUERY_KEY，
  // 调度器订阅 cache 变化时就拿不到任何 queued main run → 永远卡在「全部排队中」。
  // 这里在 layout 拉一次列表（带 polling 节流），保证调度器永远有数据可调度。
  useQuery<PipelineRunListResponse>({
    queryKey: RUNS_QUERY_KEY,
    queryFn: () => fetchMyPipelineRuns(token),
    enabled: Boolean(token),
    // 有活跃 run（queued/running）时 3 秒 polling，保证状态及时刷给调度器
    refetchInterval: (query) => {
      const items = query.state.data?.items || [];
      const hasActive = items.some((r) => r.status === "queued" || r.status === "running");
      return hasActive ? 3000 : false;
    },
  });
  return (
    <PipelineRunManagerProvider agents={agents}>
      {children}
    </PipelineRunManagerProvider>
  );
}
