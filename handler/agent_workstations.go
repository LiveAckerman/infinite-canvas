package handler

import (
	"encoding/json"
	"net/http"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

// MyAgentWorkstationCards 当前用户工作区的所有卡片。
func MyAgentWorkstationCards(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	result, err := service.ListMyAgentWorkstationCards(user.ID)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, result)
}

// SaveMyAgentWorkstationCard 加入工作区 / 修改卡片状态都走这个 upsert 接口。
func SaveMyAgentWorkstationCard(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	var item model.AgentWorkstationCard
	if err := json.NewDecoder(r.Body).Decode(&item); err != nil {
		Fail(w, "请求体格式错误")
		return
	}
	saved, err := service.SaveMyAgentWorkstationCard(user.ID, item)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, saved)
}

// DeleteMyAgentWorkstationCard 「移出工作区」时调用。
func DeleteMyAgentWorkstationCard(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	if err := service.DeleteMyAgentWorkstationCard(user.ID, id); err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, true)
}
