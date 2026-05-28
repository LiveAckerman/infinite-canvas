package service

import (
	"errors"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const (
	agentMaxNameLen         = 20
	agentMaxDescriptionLen  = 80
	agentMaxSystemPromptLen = 4000
	// 角色绑定的固定参考图最多几张。需要跟前端 modal 的 3 个槽位一致。
	agentMaxReferenceImages = 3
)

// ListMyAgents 列出当前用户的全部角色。
func ListMyAgents(userID string) (model.AgentList, error) {
	if userID == "" {
		return model.AgentList{}, errors.New("请先登录")
	}
	items, err := repository.ListAgentsByUser(userID)
	if err != nil {
		return model.AgentList{}, err
	}
	return model.AgentList{Items: items, Total: len(items)}, nil
}

// SaveMyAgent 新建或更新当前用户的角色。
// 校验：名字必填且 ≤20 字、描述 ≤80 字、systemPrompt 必填且 ≤4000 字。
// 更新场景下校验当前用户拥有该角色。
func SaveMyAgent(userID string, item model.Agent) (model.Agent, error) {
	if userID == "" {
		return item, errors.New("请先登录")
	}
	item.Name = strings.TrimSpace(item.Name)
	item.Description = strings.TrimSpace(item.Description)
	item.SystemPrompt = strings.TrimSpace(item.SystemPrompt)
	item.AvatarURL = strings.TrimSpace(item.AvatarURL)
	// 参考图：去空白 + 去重 + 限制最多 3 张；多余的截断而不是报错，避免前端兜不住的边缘 case。
	cleanRefs := make([]string, 0, len(item.ReferenceImageKeys))
	seenRef := map[string]bool{}
	for _, key := range item.ReferenceImageKeys {
		key = strings.TrimSpace(key)
		if key == "" || seenRef[key] {
			continue
		}
		seenRef[key] = true
		cleanRefs = append(cleanRefs, key)
		if len(cleanRefs) >= agentMaxReferenceImages {
			break
		}
	}
	item.ReferenceImageKeys = cleanRefs
	if item.Name == "" {
		return item, errors.New("角色名不能为空")
	}
	if len([]rune(item.Name)) > agentMaxNameLen {
		return item, errors.New("角色名最多 20 个字")
	}
	if len([]rune(item.Description)) > agentMaxDescriptionLen {
		return item, errors.New("角色描述最多 80 个字")
	}
	if item.SystemPrompt == "" {
		return item, errors.New("系统提示词不能为空")
	}
	if len(item.SystemPrompt) > agentMaxSystemPromptLen {
		return item, errors.New("系统提示词最多 4000 字")
	}

	now := time.Now().Format(time.RFC3339)
	if item.ID == "" {
		item.ID = newID("agent")
		item.CreatedAt = now
		item.UserID = userID
	} else {
		saved, ok, err := repository.GetAgentByID(item.ID)
		if err != nil {
			return item, err
		}
		if !ok || saved.UserID != userID {
			return item, errors.New("角色不存在")
		}
		item.UserID = userID
		item.CreatedAt = saved.CreatedAt
	}
	item.UpdatedAt = now
	return repository.SaveAgent(item)
}

// DeleteMyAgent 删除当前用户的角色；级联清理头像 + 参考图（如果别处没在引用）。
func DeleteMyAgent(userID string, id string) error {
	if userID == "" {
		return errors.New("请先登录")
	}
	saved, ok, err := repository.GetAgentByID(id)
	if err != nil {
		return err
	}
	if !ok || saved.UserID != userID {
		return errors.New("角色不存在")
	}
	if err := repository.DeleteAgent(id); err != nil {
		return err
	}
	keySet := map[string]bool{}
	extractImageKeysFromString(saved.AvatarURL, keySet)
	for _, k := range saved.ReferenceImageKeys {
		if k != "" {
			keySet[k] = true
		}
	}
	keys := make([]string, 0, len(keySet))
	for k := range keySet {
		keys = append(keys, k)
	}
	CleanupImagesByKeysIfOrphan(userID, keys)
	return nil
}

// IncrementAgentUsage 角色每次发起一次生图后 +1。仅在生成成功时调用，失败/被中止不计数。
// 调用方需自行确保 agentID 非空。
func IncrementAgentUsage(userID string, agentID string) error {
	if userID == "" || agentID == "" {
		return nil
	}
	saved, ok, err := repository.GetAgentByID(agentID)
	if err != nil {
		return err
	}
	if !ok || saved.UserID != userID {
		return nil
	}
	return repository.IncrementAgentUsage(agentID)
}
