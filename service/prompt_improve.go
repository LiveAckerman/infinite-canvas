package service

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

// promptImproveSystemPrompt 是注入给 LLM 的「身份 + 工作规则」。
// 这段文本仅存在后端代码里，前端永远拿不到，避免被网页 inspect 出来后变成
// 用户随意调用启用 AI 配置的入口。
const promptImproveSystemPrompt = `你是一位专业的图像生成提示词优化专家。

任务：把用户给的中文或英文描述改写成细节充足、结构清晰、易被图片生成模型理解的高质量提示词。

规则：
1. 保留用户原意，不要凭空增加无关概念。
2. 在以下维度尽量补充细节：主体描述、构图、镜头、光线、色彩、风格、画质、氛围、艺术参考。
3. 输出仅包含优化后的提示词本体——不要解释，不要加引号，不要写"以下是"、"建议"、"优化后的提示词："这类引导语。
4. 中文输入 → 中文输出；英文输入 → 英文输出。
5. 输出长度建议 80-300 字，不要写小说。
6. 不要输出 markdown 标题或列表符号，单段连贯文本即可。`

const promptImproveTimeout = 60 * time.Second

// ImprovePrompt 调启用配置的 textModel 把用户提示词改写成更精细的版本。
// 复用 service.EnabledAIConfig + chat 限流；system prompt 不暴露给前端。
func ImprovePrompt(userPrompt string) (string, error) {
	userPrompt = strings.TrimSpace(userPrompt)
	if userPrompt == "" {
		return "", errors.New("请先输入需要优化的提示词")
	}
	if len(userPrompt) > 4000 {
		return "", errors.New("提示词过长，请精简到 4000 字以内")
	}
	cfg, err := EnabledAIConfig()
	if err != nil {
		return "", err
	}

	payload := map[string]any{
		"model":  cfg.TextModel,
		"stream": false,
		"messages": []map[string]string{
			{"role": "system", "content": promptImproveSystemPrompt},
			{"role": "user", "content": userPrompt},
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	endpoint := normalizeBaseURL(cfg.BaseURL) + "/v1/chat/completions"
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: promptImproveTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return "", errors.New("提示词优化请求失败：" + err.Error())
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", errors.New(parseUpstreamError(raw, resp.StatusCode))
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", errors.New("提示词优化响应解析失败")
	}
	if len(parsed.Choices) == 0 {
		return "", errors.New("提示词优化模型无返回内容")
	}
	improved := strings.TrimSpace(parsed.Choices[0].Message.Content)
	if improved == "" {
		return "", errors.New("提示词优化模型返回空内容")
	}
	// 部分模型仍会带引号或前缀，做一次轻清洗。
	improved = strings.Trim(improved, "「」\"'`")
	return improved, nil
}
