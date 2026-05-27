package service

import (
	"errors"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const (
	pipelineMaxNameLen        = 30
	pipelineMaxDescriptionLen = 80
	// 流水线最多步数。UI 横向滚动 + 单次链式耗时 / 失败概率综合考虑。
	pipelineMaxSteps         = 10
	pipelineStepMaxExtraNote = 4000
)

// ListMyPipelines 当前用户的全部流水线。
func ListMyPipelines(userID string) (model.PipelineList, error) {
	if userID == "" {
		return model.PipelineList{}, errors.New("请先登录")
	}
	items, err := repository.ListPipelinesByUser(userID)
	if err != nil {
		return model.PipelineList{}, err
	}
	return model.PipelineList{Items: items, Total: len(items)}, nil
}

// SaveMyPipeline 新建或更新当前用户的流水线。
// 校验：名字必填 ≤30、描述 ≤80、步骤 1~10 个、每步 agentId 非空。
// 不校验「agentId 必须存在」——允许保存后该角色被删除（前端会提示「角色不存在」让用户替换）。
func SaveMyPipeline(userID string, item model.Pipeline) (model.Pipeline, error) {
	if userID == "" {
		return item, errors.New("请先登录")
	}
	item.Name = strings.TrimSpace(item.Name)
	item.Description = strings.TrimSpace(item.Description)
	if item.Name == "" {
		return item, errors.New("流水线名不能为空")
	}
	if len([]rune(item.Name)) > pipelineMaxNameLen {
		return item, errors.New("流水线名最多 30 个字")
	}
	if len([]rune(item.Description)) > pipelineMaxDescriptionLen {
		return item, errors.New("描述最多 80 个字")
	}
	if len(item.Steps) == 0 {
		return item, errors.New("流水线至少要有 1 个步骤")
	}
	if len(item.Steps) > pipelineMaxSteps {
		return item, errors.New("流水线最多 10 个步骤")
	}
	for index, step := range item.Steps {
		step.StepID = strings.TrimSpace(step.StepID)
		step.AgentID = strings.TrimSpace(step.AgentID)
		step.ExtraNote = strings.TrimSpace(step.ExtraNote)
		if step.AgentID == "" {
			return item, errors.New("步骤的角色不能为空")
		}
		if step.StepID == "" {
			// 客户端兜底：服务端给一个稳定 id 也行，但前端拖拽排序需要 stepId 保持稳定，
			// 这里只是兜底，正常前端必传。
			step.StepID = newID("pstep")
		}
		if len(step.ExtraNote) > pipelineStepMaxExtraNote {
			return item, errors.New("步骤附加说明最多 4000 字")
		}
		item.Steps[index] = step
	}

	now := time.Now().Format(time.RFC3339)
	if item.ID == "" {
		item.ID = newID("pipeline")
		item.CreatedAt = now
		item.UserID = userID
	} else {
		saved, ok, err := repository.GetPipelineByID(item.ID)
		if err != nil {
			return item, err
		}
		if !ok || saved.UserID != userID {
			return item, errors.New("流水线不存在")
		}
		item.UserID = userID
		item.CreatedAt = saved.CreatedAt
	}
	item.UpdatedAt = now
	return repository.SavePipeline(item)
}

// DeleteMyPipeline 删除流水线。
func DeleteMyPipeline(userID string, id string) error {
	if userID == "" {
		return errors.New("请先登录")
	}
	saved, ok, err := repository.GetPipelineByID(id)
	if err != nil {
		return err
	}
	if !ok || saved.UserID != userID {
		return errors.New("流水线不存在")
	}
	return repository.DeletePipeline(id)
}
