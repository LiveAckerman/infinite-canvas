package service

import (
	"errors"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const (
	// 卡片的「附加说明」沿用 agent.system_prompt 的上限，避免出现「角色提示词都能写 4000 字，
	// 但卡片说明 80 字就截断」这种不直观情形。
	agentWorkstationCardMaxExtraNoteLen = 4000
)

// ListMyAgentWorkstationCards 当前用户的工作区所有卡片。
func ListMyAgentWorkstationCards(userID string) (model.AgentWorkstationCardList, error) {
	if userID == "" {
		return model.AgentWorkstationCardList{}, errors.New("请先登录")
	}
	items, err := repository.ListAgentWorkstationCardsByUser(userID)
	if err != nil {
		return model.AgentWorkstationCardList{}, err
	}
	return model.AgentWorkstationCardList{Items: items, Total: len(items)}, nil
}

// SaveMyAgentWorkstationCard upsert 卡片，按 (user_id, agent_id) 唯一。
// 校验：必须传 AgentID，且这个角色属于当前用户；ReferenceKey / OutputKey 如果非空必须是当前用户的图片。
// 「加入工作区」「上传原图」「写附加说明」「跑完成功」「跑完失败」「重置」都共用这一个接口。
func SaveMyAgentWorkstationCard(userID string, item model.AgentWorkstationCard) (model.AgentWorkstationCard, error) {
	if userID == "" {
		return item, errors.New("请先登录")
	}
	item.AgentID = strings.TrimSpace(item.AgentID)
	if item.AgentID == "" {
		return item, errors.New("缺少 agentId")
	}
	// 校验角色归属
	agent, ok, err := repository.GetAgentByID(item.AgentID)
	if err != nil {
		return item, err
	}
	if !ok || agent.UserID != userID {
		return item, errors.New("角色不存在")
	}
	item.ReferenceKey = strings.TrimSpace(item.ReferenceKey)
	item.OutputKey = strings.TrimSpace(item.OutputKey)
	item.ExtraNote = strings.TrimSpace(item.ExtraNote)
	if len([]rune(item.ExtraNote)) > agentWorkstationCardMaxExtraNoteLen {
		return item, errors.New("附加说明最多 4000 字")
	}
	if item.ReferenceKey != "" {
		if _, err := GetImageForOwner(userID, item.ReferenceKey); err != nil {
			return item, errors.New("原图无权访问或不存在")
		}
	}
	if item.OutputKey != "" {
		if _, err := GetImageForOwner(userID, item.OutputKey); err != nil {
			return item, errors.New("产物图无权访问或不存在")
		}
	}
	if item.Status == "" {
		item.Status = model.AgentWorkstationCardStatusIdle
	}
	if item.Status != model.AgentWorkstationCardStatusIdle &&
		item.Status != model.AgentWorkstationCardStatusSuccess &&
		item.Status != model.AgentWorkstationCardStatusFailed {
		return item, errors.New("卡片状态非法（running 不入库）")
	}

	now := time.Now().Format(time.RFC3339)
	// upsert：先按 (user_id, agent_id) 查；命中就把 ID + CreatedAt 替换成原值，否则新建。
	existing, has, err := repository.GetAgentWorkstationCardByUserAndAgent(userID, item.AgentID)
	if err != nil {
		return item, err
	}
	if has {
		item.ID = existing.ID
		item.UserID = userID
		item.CreatedAt = existing.CreatedAt
	} else {
		if item.ID == "" {
			item.ID = newID("wsc")
		}
		item.UserID = userID
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	return repository.SaveAgentWorkstationCard(item)
}

// DeleteMyAgentWorkstationCard 按 ID 删除当前用户的卡片（「移出工作区」时调用）。
// 级联清理 reference / output 图片（如果别处没在引用）。
func DeleteMyAgentWorkstationCard(userID string, id string) error {
	if userID == "" {
		return errors.New("请先登录")
	}
	saved, ok, err := repository.GetAgentWorkstationCardByID(id)
	if err != nil {
		return err
	}
	if !ok || saved.UserID != userID {
		return errors.New("卡片不存在")
	}
	if err := repository.DeleteAgentWorkstationCard(id); err != nil {
		return err
	}
	keys := make([]string, 0, 2)
	if saved.ReferenceKey != "" {
		keys = append(keys, saved.ReferenceKey)
	}
	if saved.OutputKey != "" {
		keys = append(keys, saved.OutputKey)
	}
	CleanupImagesByKeysIfOrphan(userID, keys)
	return nil
}
