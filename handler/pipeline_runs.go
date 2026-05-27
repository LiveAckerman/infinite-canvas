package handler

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

// MyPipelineRuns 列表 GET /api/pipeline-runs/me
func MyPipelineRuns(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	result, err := service.ListMyPipelineRuns(user.ID)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, result)
}

// CreateMyPipelineRun POST /api/pipeline-runs/me
// body: { pipelineId, seedKey }
// 返回新建的 run（status=queued），前端 RunManager 拿到后调度执行。
func CreateMyPipelineRun(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	var payload struct {
		PipelineID string `json:"pipelineId"`
		SeedKey    string `json:"seedKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		Fail(w, "请求体格式错误")
		return
	}
	saved, err := service.CreatePipelineRun(user.ID, payload.PipelineID, payload.SeedKey)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, saved)
}

// GetMyPipelineRun 详情 GET /api/pipeline-runs/me/:id
func GetMyPipelineRun(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	saved, err := service.GetMyPipelineRun(user.ID, id)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, saved)
}

// SaveMyPipelineRun 整体覆盖更新 PUT /api/pipeline-runs/me/:id
// body: 完整 PipelineRun JSON。前端 RunManager 每推进一步就调一次。
func SaveMyPipelineRun(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	var item model.PipelineRun
	if err := json.NewDecoder(r.Body).Decode(&item); err != nil {
		Fail(w, "请求体格式错误")
		return
	}
	item.ID = id
	saved, err := service.SaveMyPipelineRun(user.ID, item)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, saved)
}

// DeleteMyPipelineRun DELETE /api/pipeline-runs/me/:id
func DeleteMyPipelineRun(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	if err := service.DeleteMyPipelineRun(user.ID, id); err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, true)
}

// DownloadMyPipelineRunZip GET /api/pipeline-runs/me/:id/zip
// 流式打包返回 seed + 各步产物。Content-Disposition 带 attachment。
// 这个接口走 raw response（不是 envelope），方便浏览器 <a download> / fetch().blob() 直接拿。
func DownloadMyPipelineRunZip(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	run, err := service.GetMyPipelineRun(user.ID, id)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	filename := fmt.Sprintf("pipeline-run-%s.zip", run.ID)
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+filename+"\"")
	w.Header().Set("Cache-Control", "no-store")
	if err := service.StreamPipelineRunZip(user.ID, id, w); err != nil {
		// 此时 header 已 flush 不能再换 envelope，只能尽力中断写
		return
	}
}
