package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

// ListAgentsByUser 返回某用户的全部角色，按 updated_at desc 排序（最近编辑/使用排前面）。
func ListAgentsByUser(userID string) ([]model.Agent, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.Agent
	err = db.Where("user_id = ?", userID).Order("updated_at desc").Find(&items).Error
	return items, err
}

// GetAgentByID 按 ID 查询角色。
func GetAgentByID(id string) (model.Agent, bool, error) {
	db, err := DB()
	if err != nil {
		return model.Agent{}, false, err
	}
	item := model.Agent{}
	err = db.Where("id = ?", id).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.Agent{}, false, nil
	}
	return item, err == nil, err
}

// SaveAgent 保存角色（新建或更新），更新时保留原 created_at / usage_count。
func SaveAgent(item model.Agent) (model.Agent, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	saved, ok, err := GetAgentByID(item.ID)
	if err != nil {
		return item, err
	}
	if ok {
		if item.CreatedAt == "" {
			item.CreatedAt = saved.CreatedAt
		}
		if item.UsageCount == 0 {
			item.UsageCount = saved.UsageCount
		}
	}
	return item, db.Save(&item).Error
}

// DeleteAgent 删除角色。
func DeleteAgent(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.Agent{}, "id = ?", id).Error
}

// IncrementAgentUsage 角色每次发起一次生图后 +1，用于角色卡片展示「已用 N 次」。
func IncrementAgentUsage(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.Agent{}).Where("id = ?", id).UpdateColumn("usage_count", gorm.Expr("usage_count + 1")).Error
}
