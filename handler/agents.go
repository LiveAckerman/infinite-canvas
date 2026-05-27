package handler

import (
	"encoding/json"
	"net/http"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

// MyAgents 当前用户的角色列表，不分页。
func MyAgents(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	result, err := service.ListMyAgents(user.ID)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, result)
}

// SaveMyAgent 新建或更新当前用户的角色。
func SaveMyAgent(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	var item model.Agent
	if err := json.NewDecoder(r.Body).Decode(&item); err != nil {
		Fail(w, "请求体格式错误")
		return
	}
	saved, err := service.SaveMyAgent(user.ID, item)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, saved)
}

// DeleteMyAgent 删除当前用户的角色。
func DeleteMyAgent(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	if err := service.DeleteMyAgent(user.ID, id); err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, true)
}
