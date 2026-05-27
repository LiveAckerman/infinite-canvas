package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

// ListPipelineRunsByUser 当前用户的全部执行流程，按 updated_at desc。
// 不分页：单用户的 run 数量一般在百级以内；如果未来需要再加分页。
func ListPipelineRunsByUser(userID string) ([]model.PipelineRun, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.PipelineRun
	err = db.Where("user_id = ?", userID).Order("updated_at desc").Find(&items).Error
	return items, err
}

// GetPipelineRunByID 按 ID 查询执行流程。
func GetPipelineRunByID(id string) (model.PipelineRun, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PipelineRun{}, false, err
	}
	item := model.PipelineRun{}
	err = db.Where("id = ?", id).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.PipelineRun{}, false, nil
	}
	return item, err == nil, err
}

// SavePipelineRun 保存（新建或整体覆盖更新）。
// 上层 service 已经做完所有校验 / 字段处理 / 时间戳更新。
func SavePipelineRun(item model.PipelineRun) (model.PipelineRun, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	saved, ok, err := GetPipelineRunByID(item.ID)
	if err != nil {
		return item, err
	}
	if ok && item.CreatedAt == "" {
		item.CreatedAt = saved.CreatedAt
	}
	return item, db.Save(&item).Error
}

// DeletePipelineRun 删除执行流程。
func DeletePipelineRun(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.PipelineRun{}, "id = ?", id).Error
}
