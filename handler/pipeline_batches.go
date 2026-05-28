package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

// MyPipelineBatches GET /api/pipeline-batches/me
func MyPipelineBatches(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	result, err := service.ListMyPipelineBatches(user.ID)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, result)
}

// CreateMyPipelineBatch POST /api/pipeline-batches/me
// body: BatchCreateRequest（有 templateId 走方式 B；否则方式 A）
func CreateMyPipelineBatch(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	var payload service.BatchCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		Fail(w, "请求体格式错误")
		return
	}
	detail, err := service.CreateMyPipelineBatch(user.ID, payload)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, detail)
}

// GetMyPipelineBatch GET /api/pipeline-batches/me/:id
func GetMyPipelineBatch(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	detail, err := service.GetMyPipelineBatchDetail(user.ID, id)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, detail)
}

// DeleteMyPipelineBatch DELETE /api/pipeline-batches/me/:id
func DeleteMyPipelineBatch(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	if err := service.DeleteMyPipelineBatch(user.ID, id); err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, true)
}

// DecideMyPipelineBatchPost POST /api/pipeline-batches/me/:id/decide-post
// body: { action: "continue" | "skip" }
func DecideMyPipelineBatchPost(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	var payload struct {
		Action string `json:"action"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		Fail(w, "请求体格式错误")
		return
	}
	action := model.PipelineBatchPostDecision(strings.TrimSpace(payload.Action))
	detail, err := service.DecideMyPipelineBatchPost(user.ID, id, action)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, detail)
}

// RecheckMyPipelineBatchPost POST /api/pipeline-batches/me/:id/recheck-post
func RecheckMyPipelineBatchPost(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	result, err := service.RecheckMyPipelineBatchPost(user.ID, id)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, result)
}

// DownloadMyPipelineBatchZip GET /api/pipeline-batches/me/:id/zip
// 流式 zip。走 raw response（不是 envelope），方便浏览器 <a download> / fetch().blob() 直接拿。
func DownloadMyPipelineBatchZip(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	detail, err := service.GetMyPipelineBatchDetail(user.ID, id)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	if detail.Batch.Status != model.PipelineBatchStatusSuccess &&
		detail.Batch.Status != model.PipelineBatchStatusPartial &&
		detail.Batch.Status != model.PipelineBatchStatusFailed {
		Fail(w, "批量任务尚未完成，无法下载")
		return
	}
	filename := service.BatchZipFilename(detail.Batch)
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+filename+"\"")
	w.Header().Set("Cache-Control", "no-store")
	if err := service.StreamPipelineBatchZip(user.ID, id, w); err != nil {
		// header 已 flush，无法切到 envelope，只能尽力中断
		return
	}
}
