package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

// ListPipelinesByUser 当前用户的全部流水线，updated_at desc。
func ListPipelinesByUser(userID string) ([]model.Pipeline, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.Pipeline
	err = db.Where("user_id = ?", userID).Order("updated_at desc").Find(&items).Error
	return items, err
}

// GetPipelineByID 按 ID 查询流水线。
func GetPipelineByID(id string) (model.Pipeline, bool, error) {
	db, err := DB()
	if err != nil {
		return model.Pipeline{}, false, err
	}
	item := model.Pipeline{}
	err = db.Where("id = ?", id).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.Pipeline{}, false, nil
	}
	return item, err == nil, err
}

// SavePipeline 保存流水线（新建或更新），更新时保留原 created_at。
func SavePipeline(item model.Pipeline) (model.Pipeline, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	saved, ok, err := GetPipelineByID(item.ID)
	if err != nil {
		return item, err
	}
	if ok && item.CreatedAt == "" {
		item.CreatedAt = saved.CreatedAt
	}
	return item, db.Save(&item).Error
}

// DeletePipeline 删除流水线。
func DeletePipeline(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.Pipeline{}, "id = ?", id).Error
}
