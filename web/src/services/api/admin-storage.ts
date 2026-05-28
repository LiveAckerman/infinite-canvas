import { apiGet, apiPost } from "@/services/api/request";

export type OrphanImageItem = {
  id: string;
  userId: string;
  username?: string;
  mimeType: string;
  size: number;
  createdAt: string;
};

export type ImageUsageByUser = {
  userId: string;
  username?: string;
  imageCount: number;
  totalBytes: number;
};

export type OrphanImageStats = {
  items: OrphanImageItem[];
  totalCount: number;
  totalBytes: number;
  usageByUser: ImageUsageByUser[];
  grandImages: number;
  grandBytes: number;
  orphanShare: number;
};

export type CleanupResult = {
  cleanedCount: number;
  freedBytes: number;
};

export async function fetchAdminStorageOrphans(token: string) {
  return apiGet<OrphanImageStats>("/api/admin/storage/orphans", undefined, token);
}

export async function cleanupAdminStorageOrphans(token: string) {
  return apiPost<CleanupResult>("/api/admin/storage/cleanup", undefined, token);
}
