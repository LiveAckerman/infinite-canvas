package service

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const (
	batchTemplateMaxNameLen        = 30
	batchTemplateMaxDescriptionLen = 200
	batchTemplateMaxItemCount      = 9
	batchTemplateMaxPostNameLen    = 30
	batchTemplateMaxSourceCount    = 6
	batchTemplateMaxAgentCount     = 10
)

// ListMyPipelineBatchTemplates 当前用户的全部批处理模板。
func ListMyPipelineBatchTemplates(userID string) (model.PipelineBatchTemplateList, error) {
	if userID == "" {
		return model.PipelineBatchTemplateList{}, errors.New("请先登录")
	}
	items, err := repository.ListPipelineBatchTemplatesByUser(userID)
	if err != nil {
		return model.PipelineBatchTemplateList{}, err
	}
	return model.PipelineBatchTemplateList{Items: items, Total: len(items)}, nil
}

// GetMyPipelineBatchTemplate 当前用户单条模板（ownership 校验）。
func GetMyPipelineBatchTemplate(userID string, id string) (model.PipelineBatchTemplate, error) {
	if userID == "" {
		return model.PipelineBatchTemplate{}, errors.New("请先登录")
	}
	saved, ok, err := repository.GetPipelineBatchTemplateByID(id)
	if err != nil {
		return model.PipelineBatchTemplate{}, err
	}
	if !ok || saved.UserID != userID {
		return model.PipelineBatchTemplate{}, errors.New("批处理模板不存在")
	}
	return saved, nil
}

// SaveMyPipelineBatchTemplate 新建或更新当前用户的批处理模板。
//   - Name 必填 ≤30 字（rune 计）
//   - Description ≤200
//   - ItemCount = len(Items) ∈ [1, 9]，每个 item.pipelineId 用户拥有
//   - Post 非空时：Post.Name ≤30；sources 数量 ∈ [1, 6]，itemIndex ∈ [0, ItemCount-1]，stepIndex >= -1；
//     agentIds 数量 ∈ [1, 10]，去重，全部用户拥有
func SaveMyPipelineBatchTemplate(userID string, item model.PipelineBatchTemplate) (model.PipelineBatchTemplate, error) {
	if userID == "" {
		return item, errors.New("请先登录")
	}
	item.Name = strings.TrimSpace(item.Name)
	item.Description = strings.TrimSpace(item.Description)
	if item.Name == "" {
		return item, errors.New("模板名称不能为空")
	}
	if len([]rune(item.Name)) > batchTemplateMaxNameLen {
		return item, fmt.Errorf("模板名称最多 %d 个字", batchTemplateMaxNameLen)
	}
	if len([]rune(item.Description)) > batchTemplateMaxDescriptionLen {
		return item, fmt.Errorf("模板描述最多 %d 个字", batchTemplateMaxDescriptionLen)
	}
	if len(item.Items) == 0 {
		return item, errors.New("模板至少包含 1 条主条")
	}
	if len(item.Items) > batchTemplateMaxItemCount {
		return item, fmt.Errorf("模板最多包含 %d 条主条", batchTemplateMaxItemCount)
	}
	cleanItems := make([]model.PipelineBatchTemplateItem, 0, len(item.Items))
	for index, it := range item.Items {
		pipelineID := strings.TrimSpace(it.PipelineID)
		if pipelineID == "" {
			return item, fmt.Errorf("第 %d 条主条的流水线不能为空", index+1)
		}
		pipeline, ok, err := repository.GetPipelineByID(pipelineID)
		if err != nil {
			return item, err
		}
		if !ok || pipeline.UserID != userID {
			return item, fmt.Errorf("第 %d 条主条的流水线不存在", index+1)
		}
		cleanItems = append(cleanItems, model.PipelineBatchTemplateItem{
			PipelineID: pipeline.ID,
			Name:       strings.TrimSpace(it.Name),
		})
	}
	item.Items = cleanItems
	item.ItemCount = len(cleanItems)

	if item.Post != nil {
		post := item.Post
		post.Name = strings.TrimSpace(post.Name)
		if len([]rune(post.Name)) > batchTemplateMaxPostNameLen {
			return item, fmt.Errorf("后处理名称最多 %d 个字", batchTemplateMaxPostNameLen)
		}
		if len(post.Sources) == 0 {
			return item, errors.New("后处理至少需要 1 个 source")
		}
		if len(post.Sources) > batchTemplateMaxSourceCount {
			return item, fmt.Errorf("后处理最多 %d 个 source", batchTemplateMaxSourceCount)
		}
		for i, src := range post.Sources {
			if src.ItemIndex < 0 || src.ItemIndex >= item.ItemCount {
				return item, fmt.Errorf("后处理第 %d 个 source 的主条序号越界", i+1)
			}
			if src.StepIndex < -1 {
				return item, fmt.Errorf("后处理第 %d 个 source 的步骤序号无效", i+1)
			}
		}
		if len(post.AgentIDs) == 0 {
			return item, errors.New("后处理至少需要 1 个角色")
		}
		if len(post.AgentIDs) > batchTemplateMaxAgentCount {
			return item, fmt.Errorf("后处理最多 %d 个角色", batchTemplateMaxAgentCount)
		}
		seen := map[string]bool{}
		cleanAgents := make([]string, 0, len(post.AgentIDs))
		for i, agentID := range post.AgentIDs {
			agentID = strings.TrimSpace(agentID)
			if agentID == "" {
				return item, fmt.Errorf("后处理第 %d 个角色不能为空", i+1)
			}
			if seen[agentID] {
				return item, errors.New("后处理角色不能重复")
			}
			seen[agentID] = true
			agent, ok, err := repository.GetAgentByID(agentID)
			if err != nil {
				return item, err
			}
			if !ok || agent.UserID != userID {
				return item, fmt.Errorf("后处理第 %d 个角色不存在", i+1)
			}
			cleanAgents = append(cleanAgents, agent.ID)
		}
		post.AgentIDs = cleanAgents
		item.Post = post
	}

	now := time.Now().Format(time.RFC3339)
	if strings.TrimSpace(item.ID) == "" {
		item.ID = newID("btpl")
		item.CreatedAt = now
		item.UserID = userID
	} else {
		saved, ok, err := repository.GetPipelineBatchTemplateByID(item.ID)
		if err != nil {
			return item, err
		}
		if !ok || saved.UserID != userID {
			return item, errors.New("批处理模板不存在")
		}
		item.UserID = userID
		item.CreatedAt = saved.CreatedAt
	}
	item.UpdatedAt = now
	return repository.SavePipelineBatchTemplate(item)
}

// DeleteMyPipelineBatchTemplate 删除批处理模板（不影响已基于该模板创建的 batches）。
func DeleteMyPipelineBatchTemplate(userID string, id string) error {
	if userID == "" {
		return errors.New("请先登录")
	}
	saved, ok, err := repository.GetPipelineBatchTemplateByID(id)
	if err != nil {
		return err
	}
	if !ok || saved.UserID != userID {
		return errors.New("批处理模板不存在")
	}
	return repository.DeletePipelineBatchTemplate(id)
}
