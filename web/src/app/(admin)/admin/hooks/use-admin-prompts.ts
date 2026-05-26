"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";

import { deleteAdminPrompt, fetchAdminPrompts, fetchAdminPromptCategories, saveAdminPrompt, syncAdminPromptCategory, type AdminPromptCategory } from "@/services/api/admin";
import { reviewPrompt, type Prompt } from "@/services/api/prompts";
import { useUserStore } from "@/stores/use-user-store";

const defaultPageSize = 10;

export function useAdminPrompts() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const token = useUserStore((state) => state.token);
  const clearSession = useUserStore((state) => state.clearSession);
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("");
  const [tag, setTag] = useState<string[]>([]);
  // 审核状态筛选：空 = 全部；"pending"/"public"/"rejected" 分别对应 Tab
  const [visibility, setVisibility] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  const categoriesQuery = useQuery({
    queryKey: ["admin", "prompt-categories", token],
    queryFn: () => fetchAdminPromptCategories(token),
    enabled: Boolean(token),
    retry: false,
  });

  const promptsQuery = useQuery({
    queryKey: ["admin", "prompts", token, keyword, category, tag, visibility, page, pageSize],
    queryFn: () => fetchAdminPrompts(token, { keyword, category, tag, visibility, page, pageSize }),
    enabled: Boolean(token),
    retry: false,
  });

  // 单独再拉一次只查 pending 的 total，用来给 Tab 上挂红点 badge（不分页，pageSize=1 够用）。
  const pendingCountQuery = useQuery({
    queryKey: ["admin", "prompts-pending-count", token],
    queryFn: () => fetchAdminPrompts(token, { visibility: "pending", pageSize: 1 }),
    enabled: Boolean(token),
    retry: false,
  });

  const syncMutation = useMutation({
    mutationFn: (category: string) => syncAdminPromptCategory(token, category),
    onSuccess: async (categories) => {
      queryClient.setQueryData<AdminPromptCategory[]>(["admin", "prompt-categories", token], categories);
      await queryClient.invalidateQueries({ queryKey: ["admin", "prompts"] });
      message.success("远程提示词源已同步");
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "同步失败");
    },
  });

  const saveMutation = useMutation({
    mutationFn: (prompt: Partial<Prompt>) => saveAdminPrompt(token, prompt),
    onSuccess: async (_, prompt) => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "prompt-categories"] });
      await queryClient.invalidateQueries({ queryKey: ["admin", "prompts"] });
      message.success(prompt.id ? "提示词已保存" : "提示词已新增");
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "保存失败");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAdminPrompt(token, id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "prompt-categories"] });
      await queryClient.invalidateQueries({ queryKey: ["admin", "prompts"] });
      message.success("提示词已删除");
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "删除失败");
    },
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => reviewPrompt(token, id, approve),
    onSuccess: async (_, { approve }) => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "prompts"] });
      await queryClient.invalidateQueries({ queryKey: ["admin", "prompts-pending-count"] });
      message.success(approve ? "已通过，提示词已公开" : "已拒绝");
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "操作失败");
    },
  });

  useEffect(() => {
    if (categoriesQuery.isError) {
      const errorMessage = categoriesQuery.error instanceof Error ? categoriesQuery.error.message : "读取提示词分类失败";
      message.error(errorMessage);
      if (errorMessage.includes("未登录") || errorMessage.includes("权限不足") || errorMessage.includes("登录状态无效")) {
        clearSession();
      }
    }
  }, [categoriesQuery.error, categoriesQuery.isError, clearSession, message]);

  useEffect(() => {
    if (promptsQuery.isError) {
      const errorMessage = promptsQuery.error instanceof Error ? promptsQuery.error.message : "读取提示词失败";
      message.error(errorMessage);
      if (errorMessage.includes("未登录") || errorMessage.includes("权限不足") || errorMessage.includes("登录状态无效")) {
        clearSession();
      }
    }
  }, [clearSession, message, promptsQuery.error, promptsQuery.isError]);

  const updateFilters = (next: Partial<{ keyword: string; category: string; tag: string[]; visibility: string; page: number; pageSize: number }>) => {
    const queryState = { keyword, category, tag, visibility, page, pageSize, ...next };
    if (next.keyword !== undefined || next.category !== undefined || next.tag !== undefined || next.visibility !== undefined || next.pageSize !== undefined) {
      queryState.page = 1;
    }
    setKeyword(queryState.keyword);
    setCategory(queryState.category);
    setTag(queryState.tag);
    setVisibility(queryState.visibility);
    setPage(queryState.page);
    setPageSize(queryState.pageSize);
  };

  const refreshPrompts = async () => {
    await categoriesQuery.refetch();
    await promptsQuery.refetch();
  };

  const data = promptsQuery.data;
  const isLoading = categoriesQuery.isFetching || promptsQuery.isFetching || saveMutation.isPending || deleteMutation.isPending;

  return {
    categories: categoriesQuery.data || [],
    prompts: data?.items || [],
    tags: data?.tags || [],
    keyword,
    category,
    tag,
    visibility,
    page,
    pageSize,
    total: data?.total || 0,
    pendingCount: pendingCountQuery.data?.total || 0,
    isLoading,
    isSyncing: syncMutation.isPending,
    syncCategory: (category: string) => syncMutation.mutateAsync(category),
    searchPrompts: (value = keyword) => updateFilters({ keyword: value }),
    changeCategory: (value: string) => updateFilters({ category: value, tag: [] }),
    changeTag: (value: string[]) => updateFilters({ tag: value }),
    changeVisibility: (value: string) => updateFilters({ visibility: value }),
    changePage: (value: number) => updateFilters({ page: value }),
    changePageSize: (value: number) => updateFilters({ pageSize: value }),
    resetFilters: () => updateFilters({ keyword: "", category: "", tag: [], visibility: "", page: 1, pageSize: defaultPageSize }),
    refreshPrompts,
    savePrompt: (prompt: Partial<Prompt>) => saveMutation.mutateAsync(prompt),
    deletePrompt: (id: string) => deleteMutation.mutateAsync(id),
    reviewPrompt: (id: string, approve: boolean) => reviewMutation.mutateAsync({ id, approve }),
  };
}
