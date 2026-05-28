package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

// ListPipelineBatchTemplatesByUser 当前用户的全部批处理模板，按 updated_at desc。
func ListPipelineBatchTemplatesByUser(userID string) ([]model.PipelineBatchTemplate, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.PipelineBatchTemplate
	err = db.Where("user_id = ?", userID).Order("updated_at desc").Find(&items).Error
	return items, err
}

// GetPipelineBatchTemplateByID 按 ID 查询批处理模板。
func GetPipelineBatchTemplateByID(id string) (model.PipelineBatchTemplate, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PipelineBatchTemplate{}, false, err
	}
	item := model.PipelineBatchTemplate{}
	err = db.Where("id = ?", id).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.PipelineBatchTemplate{}, false, nil
	}
	return item, err == nil, err
}

// SavePipelineBatchTemplate 保存（新建或整体覆盖更新）。
func SavePipelineBatchTemplate(item model.PipelineBatchTemplate) (model.PipelineBatchTemplate, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	saved, ok, err := GetPipelineBatchTemplateByID(item.ID)
	if err != nil {
		return item, err
	}
	if ok && item.CreatedAt == "" {
		item.CreatedAt = saved.CreatedAt
	}
	return item, db.Save(&item).Error
}

// DeletePipelineBatchTemplate 删除批处理模板。
func DeletePipelineBatchTemplate(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.PipelineBatchTemplate{}, "id = ?", id).Error
}
