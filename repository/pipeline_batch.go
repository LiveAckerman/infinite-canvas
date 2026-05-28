package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

// ListPipelineBatchesByUser 当前用户的全部批量任务，按 updated_at desc。
func ListPipelineBatchesByUser(userID string) ([]model.PipelineBatch, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.PipelineBatch
	err = db.Where("user_id = ?", userID).Order("updated_at desc").Find(&items).Error
	return items, err
}

// GetPipelineBatchByID 按 ID 查询批量任务。
func GetPipelineBatchByID(id string) (model.PipelineBatch, bool, error) {
	db, err := DB()
	if err != nil {
		return model.PipelineBatch{}, false, err
	}
	item := model.PipelineBatch{}
	err = db.Where("id = ?", id).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.PipelineBatch{}, false, nil
	}
	return item, err == nil, err
}

// SavePipelineBatch 保存（新建或整体覆盖更新）。
func SavePipelineBatch(item model.PipelineBatch) (model.PipelineBatch, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	saved, ok, err := GetPipelineBatchByID(item.ID)
	if err != nil {
		return item, err
	}
	if ok && item.CreatedAt == "" {
		item.CreatedAt = saved.CreatedAt
	}
	return item, db.Save(&item).Error
}

// DeletePipelineBatch 删除批量任务（不级联 runs，由 service 层负责）。
func DeletePipelineBatch(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.PipelineBatch{}, "id = ?", id).Error
}

// ListPipelineRunsByBatch 按 batch_id 拉所有 runs，position asc。
func ListPipelineRunsByBatch(batchID string) ([]model.PipelineRun, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.PipelineRun
	err = db.Where("batch_id = ?", batchID).Order("position asc").Find(&items).Error
	return items, err
}

// DeletePipelineRunsByBatch 删除某批次下的所有 runs。
func DeletePipelineRunsByBatch(batchID string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Where("batch_id = ?", batchID).Delete(&model.PipelineRun{}).Error
}

// DeletePipelineRunsByBatchAndKind 删除某批次下指定 kind 的所有 runs（如只删 post）。
func DeletePipelineRunsByBatchAndKind(batchID string, kind model.PipelineRunKind) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Where("batch_id = ? AND kind = ?", batchID, kind).Delete(&model.PipelineRun{}).Error
}
