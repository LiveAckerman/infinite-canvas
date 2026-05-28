package handler

import (
	"encoding/json"
	"net/http"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

// MyPipelineBatchTemplates GET /api/pipeline-batch-templates/me
func MyPipelineBatchTemplates(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	result, err := service.ListMyPipelineBatchTemplates(user.ID)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, result)
}

// SaveMyPipelineBatchTemplate POST /api/pipeline-batch-templates/me
// body: 完整 PipelineBatchTemplate；id 为空 = 新建
func SaveMyPipelineBatchTemplate(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	var item model.PipelineBatchTemplate
	if err := json.NewDecoder(r.Body).Decode(&item); err != nil {
		Fail(w, "请求体格式错误")
		return
	}
	saved, err := service.SaveMyPipelineBatchTemplate(user.ID, item)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, saved)
}

// DeleteMyPipelineBatchTemplate DELETE /api/pipeline-batch-templates/me/:id
func DeleteMyPipelineBatchTemplate(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	if err := service.DeleteMyPipelineBatchTemplate(user.ID, id); err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, true)
}
