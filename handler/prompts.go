package handler

import (
	"encoding/json"
	"net/http"

	"github.com/basketikun/infinite-canvas/service"
)

func Prompts(w http.ResponseWriter, r *http.Request) {
	q := parseQuery(r)
	// 前台 /prompts 列表强制只看「已通过审核」+ 历史无 visibility 的旧数据，
	// 不让 pending / rejected 漏出来。
	q.Visibility = "public-only"
	result, err := service.ListPrompts(q)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, result)
}

// SubmitPrompt 普通用户从 /image/{id} 把生图记录提交为提示词，进 pending 审核队列。
func SubmitPrompt(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	var payload struct {
		Title        string   `json:"title"`
		Prompt       string   `json:"prompt"`
		Category     string   `json:"category"`
		Tags         []string `json:"tags"`
		CoverImageID string   `json:"coverImageId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		Fail(w, "请求体格式错误")
		return
	}
	saved, err := service.SubmitPrompt(user.ID, payload.Title, payload.Prompt, payload.Category, payload.Tags, payload.CoverImageID)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, saved)
}

// AdminReviewPrompt 管理员审核：approve=true 通过 / false 拒绝。
func AdminReviewPrompt(w http.ResponseWriter, r *http.Request, id string) {
	var payload struct {
		Approve bool `json:"approve"`
	}
	_ = json.NewDecoder(r.Body).Decode(&payload)
	if err := service.ReviewPrompt(id, payload.Approve); err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, true)
}
