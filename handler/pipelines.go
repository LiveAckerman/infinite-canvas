package handler

import (
	"encoding/json"
	"net/http"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

// MyPipelines 当前用户的流水线列表（不分页）。
func MyPipelines(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	result, err := service.ListMyPipelines(user.ID)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, result)
}

// SaveMyPipeline 新建 / 更新流水线（保存 / 重命名 / 复制 / 改步骤都走这个接口）。
func SaveMyPipeline(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	var item model.Pipeline
	if err := json.NewDecoder(r.Body).Decode(&item); err != nil {
		Fail(w, "请求体格式错误")
		return
	}
	saved, err := service.SaveMyPipeline(user.ID, item)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, saved)
}

// DeleteMyPipeline 删除流水线。
func DeleteMyPipeline(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	if err := service.DeleteMyPipeline(user.ID, id); err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, true)
}
