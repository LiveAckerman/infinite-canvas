package handler

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

// ImprovePrompt 反代「提示词优化」请求：
// - 需登录（requireUser）
// - 受 chat 限流约束（每用户 5/min），跟 /v1/chat/completions 共享配额，避免被用来无限薅 textModel
// - admin 跳过限流
// - 系统提示在 service 层硬编码，前端只能发 user prompt，无法操纵身份
func ImprovePrompt(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	if user.Role != model.UserRoleAdmin {
		allowed, retry := service.AllowChat(user.ID)
		if !allowed {
			Fail(w, fmt.Sprintf("请求过于频繁，请约 %d 秒后再试", int(retry.Seconds())+1))
			return
		}
	}

	var payload struct {
		Prompt string `json:"prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		Fail(w, "请求体格式错误")
		return
	}
	improved, err := service.ImprovePrompt(payload.Prompt)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, map[string]any{"improved": improved})
}
