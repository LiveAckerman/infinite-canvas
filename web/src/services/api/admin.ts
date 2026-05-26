import { apiDelete, apiGet, apiPost, compactApiParams } from "@/services/api/request";
import type { Prompt, PromptListResponse } from "@/services/api/prompts";

export type AdminPromptCategory = {
  category: string;
  name: string;
  description: string;
  file: string;
  githubUrl: string;
  remote: boolean;
};

export async function fetchAdminPromptCategories(token: string) {
  return apiGet<AdminPromptCategory[]>("/api/admin/prompt-categories", undefined, token);
}

export async function syncAdminPromptCategory(token: string, category: string) {
  return apiPost<AdminPromptCategory[]>("/api/admin/prompt-categories/sync", { category }, token);
}

export type AdminPromptQuery = {
  keyword?: string;
  category?: string;
  tag?: string[];
  // public-only / public / pending / rejected
  visibility?: string;
  page?: number;
  pageSize?: number;
};

export type AdminAsset = {
  id: string;
  title: string;
  type: "text" | "image" | "video";
  coverUrl: string;
  tags: string[];
  category: string;
  description: string;
  content: string;
  url: string;
  createdAt: string;
  updatedAt: string;
};

export type AdminAssetListResponse = {
  items: AdminAsset[];
  tags: string[];
  total: number;
};

export async function fetchAdminPrompts(token: string, query: AdminPromptQuery = {}) {
  return apiGet<PromptListResponse>("/api/admin/prompts", compactApiParams(query), token);
}

export async function saveAdminPrompt(token: string, prompt: Partial<Prompt>) {
  return apiPost<Prompt>("/api/admin/prompts", prompt, token);
}

export async function deleteAdminPrompt(token: string, id: string) {
  return apiDelete<boolean>(`/api/admin/prompts/${encodeURIComponent(id)}`, token);
}

export type AdminAssetQuery = {
  keyword?: string;
  type?: string;
  tag?: string[];
  page?: number;
  pageSize?: number;
};

export async function fetchAdminAssets(token: string, query: AdminAssetQuery = {}) {
  return apiGet<AdminAssetListResponse>(
    "/api/admin/assets",
    compactApiParams(query),
    token,
  );
}

export async function saveAdminAsset(token: string, asset: Partial<AdminAsset>) {
  return apiPost<AdminAsset>("/api/admin/assets", asset, token);
}

export async function deleteAdminAsset(token: string, id: string) {
  return apiDelete<boolean>(`/api/admin/assets/${encodeURIComponent(id)}`, token);
}
