package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

// 上游接口超时：图片生成可能较慢，给到 5 分钟。
const upstreamTimeout = 5 * time.Minute

// AIImageGenerations 反代 OpenAI 兼容的 /v1/images/generations，并按返回图片张数扣额度。
//
// 额度扣减采用 reserve-then-confirm 模式（防止并发请求都看到正余额都过 pre-check 的 race）：
//  1. 请求开始时按 payload.n（默认 1）原子预扣
//  2. 上游失败 / 返回数量 0 → 全额退回
//  3. 上游返回 N < 预扣数 → 退回差额
// 这样无论用户并发点几次 / 多 tab，DB 层都保证不会超扣。
func AIImageGenerations(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	cfg, ok := requireEnabledConfig(w)
	if !ok {
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		Fail(w, "请求体读取失败")
		return
	}
	payload := map[string]any{}
	if len(bytes.TrimSpace(body)) > 0 {
		if err := json.Unmarshal(body, &payload); err != nil {
			Fail(w, "请求体格式错误")
			return
		}
	}
	payload["model"] = cfg.ImageModel
	payload["response_format"] = "b64_json"

	reserved := requestedImageCount(payload)
	isAdmin := user.Role == model.UserRoleAdmin
	if !isAdmin {
		balance, ok, err := service.ConsumeCredits(user.ID, reserved)
		if err != nil {
			log.Printf("reserve credits failed user=%s amount=%d err=%v", user.ID, reserved, err)
			Fail(w, "额度预扣失败，请稍后再试")
			return
		}
		if !ok {
			Fail(w, "额度不足，请联系管理员")
			return
		}
		_ = balance // 真正写流水放到上游成功之后；这里只保证「能扣到」
	}

	raw, status, err := postUpstreamJSON(cfg, "/v1/images/generations", payload)
	if err != nil {
		refundOnFailure(user, isAdmin, reserved)
		Fail(w, err.Error())
		return
	}
	if status < 200 || status >= 300 {
		refundOnFailure(user, isAdmin, reserved)
		Fail(w, parseUpstreamMessage(raw, status))
		return
	}

	count := countImagePayload(raw)
	if count == 0 {
		refundOnFailure(user, isAdmin, reserved)
		Fail(w, "上游未返回图片")
		return
	}

	remaining := -1
	if !isAdmin {
		// 上游可能给得比预扣少（用户要 3 张但只回来 2 张），把差额退回。
		if count < reserved {
			balance, err := service.RefundCredits(user.ID, reserved-count)
			if err != nil {
				log.Printf("refund credits diff failed user=%s diff=%d err=%v", user.ID, reserved-count, err)
			}
			remaining = balance
		} else {
			// 上游给得不比预扣多（API 不会超发，但兜底）；直接读最新余额
			refreshed, _, _ := service.ConsumeCredits(user.ID, 0)
			remaining = refreshed
		}
		logImageConsume(user.ID, count, remaining, cfg.ImageModel, "文生图")
	}

	OK(w, wrapImageResult(raw, remaining))
}

// AIImageEdits 反代 /v1/images/edits（multipart），按返回图片张数扣额度。
//
// 同时支持两种入参方式：
//   - application/json：{ prompt, n, size?, quality?, references: ["img-xxx", ...] }
//     references 是已经上传过的 images.id；后端按 owner 校验后从磁盘读取，
//     再自己拼 multipart 转发到上游。请求体只有 KB 级。
//   - multipart/form-data：保留原始路径，兼容画布里截屏/裁剪后还没存盘的瞬时图。
func AIImageEdits(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	cfg, ok := requireEnabledConfig(w)
	if !ok {
		return
	}

	// 跟 AIImageGenerations 一样的 reserve-then-confirm 模式。
	// /v1/images/edits 的「n」从 form 里读不太方便（multipart 还没写呢），所以这里
	// 先按「最大 1 张」预扣，绝大多数图生图都是 n=1；下游真返回多张再补扣。
	// 这个保守预扣不会少扣（最坏多预扣 1）但杜绝 race 漏单。
	reserved := requestedEditsCount(r)
	isAdmin := user.Role == model.UserRoleAdmin
	if !isAdmin {
		balance, ok, err := service.ConsumeCredits(user.ID, reserved)
		if err != nil {
			log.Printf("reserve credits failed user=%s amount=%d err=%v", user.ID, reserved, err)
			Fail(w, "额度预扣失败，请稍后再试")
			return
		}
		if !ok {
			Fail(w, "额度不足，请联系管理员")
			return
		}
		_ = balance
	}

	bodyBuf := &bytes.Buffer{}
	writer := multipart.NewWriter(bodyBuf)

	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		if !writeEditsFromJSON(w, r, user, writer) {
			refundOnFailure(user, isAdmin, reserved)
			return
		}
	} else {
		if !writeEditsFromMultipart(w, r, writer) {
			refundOnFailure(user, isAdmin, reserved)
			return
		}
	}

	_ = writer.WriteField("model", cfg.ImageModel)
	_ = writer.WriteField("response_format", "b64_json")
	if err := writer.Close(); err != nil {
		refundOnFailure(user, isAdmin, reserved)
		Fail(w, "请求构造失败")
		return
	}

	endpoint := upstreamURL(cfg.BaseURL, "/v1/images/edits")
	// 把 multipart body 定格成 bytes，重试时每次新建 reader 重放（bytes.Buffer 被消费后不能重读）。
	payloadBytes := bodyBuf.Bytes()
	contentType := writer.FormDataContentType()
	client := &http.Client{Timeout: upstreamTimeout}
	raw, status, err := doUpstreamWithRetry(client, func() (*http.Request, error) {
		req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(payloadBytes))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
		req.Header.Set("Content-Type", contentType)
		return req, nil
	})
	if err != nil {
		refundOnFailure(user, isAdmin, reserved)
		Fail(w, err.Error())
		return
	}
	if status < 200 || status >= 300 {
		refundOnFailure(user, isAdmin, reserved)
		Fail(w, parseUpstreamMessage(raw, status))
		return
	}
	count := countImagePayload(raw)
	if count == 0 {
		refundOnFailure(user, isAdmin, reserved)
		Fail(w, "上游未返回图片")
		return
	}
	remaining := -1
	if !isAdmin {
		if count < reserved {
			balance, err := service.RefundCredits(user.ID, reserved-count)
			if err != nil {
				log.Printf("refund credits diff failed user=%s diff=%d err=%v", user.ID, reserved-count, err)
			}
			remaining = balance
		} else if count > reserved {
			// 极少见：上游真给得比预扣多（比如 n=1 预扣但回来 2 张）。补扣差额。
			// 若补扣失败（用户余额不够补），也不强制拒绝，按 reserved 张数计费；
			// 多生的几张算白送，避免错误地把已经返回的图扔掉。
			extra := count - reserved
			if _, ok, err := service.ConsumeCredits(user.ID, extra); err != nil || !ok {
				log.Printf("extra-consume credits insufficient user=%s extra=%d ok=%v err=%v", user.ID, extra, ok, err)
				count = reserved
			}
			refreshed, _, _ := service.ConsumeCredits(user.ID, 0)
			remaining = refreshed
		} else {
			refreshed, _, _ := service.ConsumeCredits(user.ID, 0)
			remaining = refreshed
		}
		logImageConsume(user.ID, count, remaining, cfg.ImageModel, "图生图")
	}
	OK(w, wrapImageResult(raw, remaining))
}

// AIChatCompletions 反代 /v1/chat/completions，支持流式响应；按用户做限流。
func AIChatCompletions(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	cfg, ok := requireEnabledConfig(w)
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

	body, err := io.ReadAll(r.Body)
	if err != nil {
		Fail(w, "请求体读取失败")
		return
	}
	payload := map[string]any{}
	if len(bytes.TrimSpace(body)) > 0 {
		if err := json.Unmarshal(body, &payload); err != nil {
			Fail(w, "请求体格式错误")
			return
		}
	}
	payload["model"] = cfg.TextModel
	rebuilt, err := json.Marshal(payload)
	if err != nil {
		Fail(w, "请求体构造失败")
		return
	}

	endpoint := upstreamURL(cfg.BaseURL, "/v1/chat/completions")
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(rebuilt))
	if err != nil {
		Fail(w, "请求构造失败")
		return
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")
	if accept := r.Header.Get("Accept"); accept != "" {
		req.Header.Set("Accept", accept)
	}

	client := &http.Client{Timeout: upstreamTimeout}
	resp, err := client.Do(req)
	if err != nil {
		Fail(w, "上游请求失败："+err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(resp.Body)
		Fail(w, parseUpstreamMessage(raw, resp.StatusCode))
		return
	}

	for key, values := range resp.Header {
		if strings.EqualFold(key, "Content-Length") {
			continue
		}
		for _, v := range values {
			w.Header().Add(key, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 4096)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			return
		}
	}
}

// AIModels 反代 /v1/models（仅管理员可用，普通用户没必要选模型）。
func AIModels(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	if user.Role != model.UserRoleAdmin {
		Fail(w, "权限不足")
		return
	}
	cfg, ok := requireEnabledConfig(w)
	if !ok {
		return
	}
	endpoint := upstreamURL(cfg.BaseURL, "/v1/models")
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		Fail(w, "请求构造失败")
		return
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		Fail(w, "上游请求失败："+err.Error())
		return
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		Fail(w, parseUpstreamMessage(raw, resp.StatusCode))
		return
	}
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		Fail(w, "上游响应解析失败")
		return
	}
	OK(w, payload)
}

func requireUser(w http.ResponseWriter, r *http.Request) (model.AuthUser, bool) {
	user, ok := service.UserFromContext(r.Context())
	if !ok || user.ID == "" {
		Fail(w, "请先登录")
		return model.AuthUser{}, false
	}
	return user, true
}

func requireEnabledConfig(w http.ResponseWriter) (model.AIConfig, bool) {
	cfg, err := service.EnabledAIConfig()
	if err != nil {
		Fail(w, err.Error())
		return model.AIConfig{}, false
	}
	return cfg, true
}

func postUpstreamJSON(cfg model.AIConfig, path string, payload any) ([]byte, int, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, err
	}
	endpoint := upstreamURL(cfg.BaseURL, path)
	client := &http.Client{Timeout: upstreamTimeout}
	// buildReq 每次构造全新请求（body 用 bytes.NewReader 可重放），交给重试逻辑。
	return doUpstreamWithRetry(client, func() (*http.Request, error) {
		req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
		req.Header.Set("Content-Type", "application/json")
		return req, nil
	})
}

// upstreamMaxAttempts 含首次在内的最大尝试次数（首发 + 最多 2 次重试）。
const upstreamMaxAttempts = 3

// upstreamRetryBackoff 每次重试前的等待。索引 0 = 第 1 次重试前；超出长度则用最后一个值。
var upstreamRetryBackoff = []time.Duration{2 * time.Second, 4 * time.Second}

// retryableUpstreamStatus 判断这个 HTTP 状态码是否值得重试。
// 502/503/504 是网关/上游瞬时故障——线上实测多为上游账号池限流（Too many concurrent
// requests）、个别账号 token 失效、或上游 30s 超时。换个账号 / 过几秒并发降下来往往就成功，
// 重试很可能命中可用账号。4xx 业务错误（额度 / 鉴权 / 参数）和 2xx 都不重试。
func retryableUpstreamStatus(status int) bool {
	return status == http.StatusBadGateway ||
		status == http.StatusServiceUnavailable ||
		status == http.StatusGatewayTimeout
}

// doUpstreamWithRetry 用 buildReq 每次构造全新请求（body 必须可重放），对 502/503/504 以及
// 网络层瞬断自动重试，最多 upstreamMaxAttempts 次。返回最后一次的 raw body + status + err。
// 注意：buildReq 里不要复用已被 http.Client 消费过的 Body，要每次新建 reader。
func doUpstreamWithRetry(client *http.Client, buildReq func() (*http.Request, error)) ([]byte, int, error) {
	var lastRaw []byte
	var lastStatus int
	var lastErr error
	for attempt := 0; attempt < upstreamMaxAttempts; attempt++ {
		if attempt > 0 {
			idx := attempt - 1
			if idx >= len(upstreamRetryBackoff) {
				idx = len(upstreamRetryBackoff) - 1
			}
			time.Sleep(upstreamRetryBackoff[idx])
		}
		req, err := buildReq()
		if err != nil {
			return nil, 0, err
		}
		resp, err := client.Do(req)
		if err != nil {
			// 网络层错误（连接重置 / 超时等）也算瞬时故障，继续重试
			lastErr, lastRaw, lastStatus = err, nil, 0
			log.Printf("upstream %s network error (attempt %d/%d): %v", req.URL.Path, attempt+1, upstreamMaxAttempts, err)
			continue
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		lastRaw, lastStatus, lastErr = raw, resp.StatusCode, nil
		if !retryableUpstreamStatus(resp.StatusCode) {
			return raw, resp.StatusCode, nil
		}
		log.Printf("upstream %s returned %d (attempt %d/%d), retrying", req.URL.Path, resp.StatusCode, attempt+1, upstreamMaxAttempts)
	}
	if lastErr != nil {
		return nil, 0, fmt.Errorf("上游请求失败：%s", lastErr.Error())
	}
	return lastRaw, lastStatus, nil
}

// upstreamURL 把用户填的 baseUrl 和 path 拼成最终 URL，兼容 baseUrl 已含 /v1 的情况。
func upstreamURL(baseURL string, path string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if strings.HasSuffix(base, "/v1") && strings.HasPrefix(path, "/v1/") {
		return base + strings.TrimPrefix(path, "/v1")
	}
	return base + path
}

// logImageConsume 写一条生图消耗流水。
func logImageConsume(userID string, count int, balance int, modelName string, remark string) {
	if err := service.LogCreditChange(model.CreditLog{
		UserID:  userID,
		Type:    model.CreditLogTypeConsume,
		Amount:  -count,
		Balance: balance,
		Model:   modelName,
		Remark:  remark,
	}); err != nil {
		log.Printf("write consume credit log failed user=%s err=%v", userID, err)
	}
}

// wrapImageResult 把上游 JSON 包装成 {upstream, remaining, upstreamMeta} 结构。
// upstream 是完整 JSON（含 b64_json，前端用于落盘）；
// upstreamMeta 是脱敏后的 raw 字符串（去掉 b64_json 大字段），前端会回写到 generations 表供 admin 审计用。
func wrapImageResult(raw []byte, remaining int) map[string]any {
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		payload = nil
	}
	return map[string]any{
		"upstream":     payload,
		"remaining":    remaining,
		"upstreamMeta": redactUpstreamMeta(raw),
	}
}

// redactUpstreamMeta 把 OpenAI 兼容生图响应里的 b64_json 字段抹掉再序列化回 JSON 字符串，
// 保留 created / data[].revised_prompt / data[].url 等可读元信息。
// 解析失败时退化为原始字符串（截断到 4KB 以防极端情况）。
func redactUpstreamMeta(raw []byte) string {
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		if len(raw) > 4096 {
			return string(raw[:4096]) + "...(truncated)"
		}
		return string(raw)
	}
	if list, ok := parsed["data"].([]any); ok {
		for _, item := range list {
			if itemMap, ok := item.(map[string]any); ok {
				if v, ok := itemMap["b64_json"].(string); ok && v != "" {
					itemMap["b64_json"] = fmt.Sprintf("<%d bytes redacted>", len(v))
				}
			}
		}
	}
	out, err := json.Marshal(parsed)
	if err != nil {
		return ""
	}
	return string(out)
}

// requestedImageCount 从 /v1/images/generations 的 JSON payload 里读出请求张数 n。
// 范围 1~15（跟前端 image.ts 的 clamp 一致），缺省 1。
func requestedImageCount(payload map[string]any) int {
	n := 1
	if v, ok := payload["n"]; ok {
		switch value := v.(type) {
		case float64:
			n = int(value)
		case int:
			n = value
		case string:
			if parsed, err := strconv.Atoi(value); err == nil {
				n = parsed
			}
		}
	}
	if n < 1 {
		n = 1
	}
	if n > 15 {
		n = 15
	}
	return n
}

// requestedEditsCount 从 /v1/images/edits 的 form / json 入参里尽量读出 n。
// edits 大多数情况下 n=1（图生图就 1 张产物），所以读取失败也不算严重错误，缺省 1。
// 这里只是给「reserve-then-confirm」预扣的初始值用，上游真返回多张时会补扣，少返回时会退回。
func requestedEditsCount(r *http.Request) int {
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		// JSON 路径：读 body 但又会被后续 multipart 写入用到，所以 io.ReadAll 后重置不可行。
		// 偷懒：直接默认 1（绝大多数 edits 都是 1 张）。即便用户真传 n=N，预扣 1 + 后面补扣 N-1
		// 走同一条路径，行为正确。
		return 1
	}
	// multipart 路径：解析 form 又会被后续 multipart 阻断；同样保守按 1 预扣
	return 1
}

// refundOnFailure 上游失败 / 准备 multipart 失败时，把预扣的额度退回去。
// 管理员不参与扣减，跳过；reserved=0 也不需要退。
func refundOnFailure(user model.AuthUser, isAdmin bool, reserved int) {
	if isAdmin || reserved <= 0 {
		return
	}
	if _, err := service.RefundCredits(user.ID, reserved); err != nil {
		log.Printf("refund credits failed user=%s amount=%d err=%v", user.ID, reserved, err)
	}
}

func countImagePayload(raw []byte) int {
	var payload struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return 0
	}
	count := 0
	for _, item := range payload.Data {
		if v, ok := item["b64_json"].(string); ok && v != "" {
			count++
			continue
		}
		if v, ok := item["url"].(string); ok && v != "" {
			count++
		}
	}
	return count
}

func parseUpstreamMessage(raw []byte, status int) string {
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &payload); err == nil && payload.Error.Message != "" {
		return payload.Error.Message
	}
	// 网关层（nginx/cloudflare 等）返回的 HTML 错误页千万别透传给前端，
	// 否则浏览器会看到一整段 <html><head><title>504...</title> 整段文本。
	// 优先按 HTTP 状态码给中文可读提示，HTML 都压成"上游响应异常"。
	if msg := friendlyStatusMessage(status); msg != "" {
		return msg
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && len(trimmed) < 500 && !looksLikeHTML(trimmed) {
		return string(trimmed)
	}
	return fmt.Sprintf("上游响应异常：%d", status)
}

// friendlyStatusMessage 把常见网关/上游错误码翻译成中文，配合 503/504 等场景。
func friendlyStatusMessage(status int) string {
	switch status {
	case http.StatusBadGateway:
		return "上游服务异常（502 Bad Gateway），请稍后再试"
	case http.StatusServiceUnavailable:
		return "上游服务暂不可用（503），请稍后再试"
	case http.StatusGatewayTimeout:
		return "上游服务响应超时（504），请稍后再试"
	}
	return ""
}

func looksLikeHTML(body []byte) bool {
	if len(body) == 0 {
		return false
	}
	if body[0] == '<' {
		return true
	}
	head := body
	if len(head) > 128 {
		head = head[:128]
	}
	lower := bytes.ToLower(head)
	return bytes.Contains(lower, []byte("<html")) || bytes.Contains(lower, []byte("<!doctype html"))
}

// editsJSONReferenceLimit 限制图生图最多带几张参考图，防止有人发巨量 id 让后端
// 一次性把 N 张大图从磁盘读进内存。
// gpt-image-2 上游官方上限是 16 张，但实践中超过 4 张时模型对各参考图的关注度会
// 被稀释、成功率明显下降。当前产品上限定在 **9 张**，兼顾「比 4 张多一点的余量」
// 和「不让用户拿着 16 张去喂模型遭遇质量崩」。如要调整改这一处常量即可。
const editsJSONReferenceLimit = 9

// writeEditsFromJSON 处理 application/json 入参的 /v1/images/edits 调用：
// 把 prompt/n/size/quality 写入 multipart 文本字段，把 references 按 storageKey 从磁盘
// 读出来当 "image" 文件字段塞进去。失败时已经 Fail，返回 false 告知上层立即返回。
func writeEditsFromJSON(w http.ResponseWriter, r *http.Request, user model.AuthUser, writer *multipart.Writer) bool {
	var payload struct {
		Prompt     string   `json:"prompt"`
		N          any      `json:"n"`
		Size       string   `json:"size"`
		Quality    string   `json:"quality"`
		References []string `json:"references"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		Fail(w, "请求体格式错误")
		return false
	}
	prompt := strings.TrimSpace(payload.Prompt)
	if prompt == "" {
		Fail(w, "提示词不能为空")
		return false
	}
	if len(payload.References) == 0 {
		Fail(w, "请至少提供一张参考图")
		return false
	}
	if len(payload.References) > editsJSONReferenceLimit {
		Fail(w, fmt.Sprintf("参考图数量超过上限（最多 %d 张）", editsJSONReferenceLimit))
		return false
	}

	_ = writer.WriteField("prompt", prompt)
	if n := normalizeEditsN(payload.N); n != "" {
		_ = writer.WriteField("n", n)
	}
	if payload.Size != "" {
		_ = writer.WriteField("size", payload.Size)
	}
	if payload.Quality != "" {
		_ = writer.WriteField("quality", payload.Quality)
	}

	for _, storageKey := range payload.References {
		storageKey = strings.TrimSpace(storageKey)
		if storageKey == "" {
			continue
		}
		image, err := service.GetImageForOwner(user.ID, storageKey)
		if err != nil {
			Fail(w, err.Error())
			return false
		}
		file, err := os.Open(service.ImageAbsPath(image))
		if err != nil {
			Fail(w, "参考图文件丢失")
			return false
		}
		filename := filepath.Base(image.Path)
		part, err := writer.CreateFormFile("image", filename)
		if err != nil {
			_ = file.Close()
			Fail(w, "请求构造失败")
			return false
		}
		_, copyErr := io.Copy(part, file)
		_ = file.Close()
		if copyErr != nil {
			Fail(w, "参考图读取失败")
			return false
		}
	}
	return true
}

// writeEditsFromMultipart 处理 multipart/form-data 入参（旧路径，画布里截屏/裁剪后
// 还没上传到服务器的瞬时图仍走这里）。把 r.MultipartForm 的所有字段透传到 writer，
// 过滤掉 model/response_format 防止客户端覆盖管理后台启用配置。
func writeEditsFromMultipart(w http.ResponseWriter, r *http.Request, writer *multipart.Writer) bool {
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		Fail(w, "请求体解析失败")
		return false
	}
	for key, values := range r.MultipartForm.Value {
		if key == "model" || key == "response_format" {
			continue
		}
		for _, v := range values {
			_ = writer.WriteField(key, v)
		}
	}
	for key, files := range r.MultipartForm.File {
		for _, fh := range files {
			part, err := writer.CreateFormFile(key, fh.Filename)
			if err != nil {
				Fail(w, "请求构造失败")
				return false
			}
			f, err := fh.Open()
			if err != nil {
				Fail(w, "请求文件读取失败")
				return false
			}
			_, copyErr := io.Copy(part, f)
			_ = f.Close()
			if copyErr != nil {
				Fail(w, "请求文件读取失败")
				return false
			}
		}
	}
	return true
}

// normalizeEditsN 把 client 传的 n（可能是 number / 数字字符串）规范化成 multipart 字段
// 期望的字符串；空 / 0 / 非数字都返回 "" 表示不带这个字段（上游 OpenAI 兼容接口会用默认值 1）。
func normalizeEditsN(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(v)
	case float64:
		n := int(v)
		if n <= 0 {
			return ""
		}
		return strconv.Itoa(n)
	case int:
		if v <= 0 {
			return ""
		}
		return strconv.Itoa(v)
	}
	return ""
}
