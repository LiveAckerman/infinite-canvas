package handler

import (
	"encoding/json"
	"net/http"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

func MyGenerations(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	result, err := service.ListGenerations(user.ID, parseQuery(r))
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, result)
}

func SaveMyGeneration(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	var item model.Generation
	_ = json.NewDecoder(r.Body).Decode(&item)
	saved, err := service.SaveGeneration(user.ID, item)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, saved)
}

// RunMyGeneration 发起一次后端任务化生图：建（或追加）一条 running 记录 + 起后台任务，立即返回记录。
func RunMyGeneration(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	var in service.StartGenerationInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		Fail(w, "请求体格式错误")
		return
	}
	saved, err := service.StartImageGeneration(user.ID, in)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, saved)
}

// GetMyGeneration 取单条生图记录（owner 校验），前端轮询进度用。
func GetMyGeneration(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	gen, err := service.GetMyGeneration(user.ID, id)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, gen)
}

// RetryMyGeneration 重试一条记录里的失败槽（删一条 error，置 running，后台补跑）。id 走 body。
func RetryMyGeneration(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		Fail(w, "请求体格式错误")
		return
	}
	saved, err := service.RetryMyGeneration(user.ID, body.ID)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, saved)
}

func DeleteMyGeneration(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	if err := service.DeleteGeneration(user.ID, id); err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, true)
}

// AdminGenerations 管理后台：分页查全部用户的生图历史。
func AdminGenerations(w http.ResponseWriter, r *http.Request) {
	q := parseQuery(r)
	if v := r.URL.Query().Get("userId"); v != "" {
		q.UserID = v
	}
	if v := r.URL.Query().Get("status"); v != "" {
		q.Type = v
	}
	result, err := service.ListAllGenerationsForAdmin(q)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, result)
}
