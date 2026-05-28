package handler

import (
	"net/http"

	"github.com/basketikun/infinite-canvas/service"
)

// AdminStorageOrphans 管理后台「存储管理」页主接口：返回孤儿图片列表 + 全库使用统计。
// 不实际清理。前端拿到 orphanCount / orphanBytes 后再决定要不要点「清理」。
func AdminStorageOrphans(w http.ResponseWriter, r *http.Request) {
	stats, err := service.FindOrphanImages()
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, stats)
}

// AdminStorageCleanup 实际执行孤儿清理。返回清掉数 + 释放字节数。
func AdminStorageCleanup(w http.ResponseWriter, r *http.Request) {
	count, freed, err := service.CleanupOrphanImages()
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, map[string]any{
		"cleanedCount": count,
		"freedBytes":   freed,
	})
}
