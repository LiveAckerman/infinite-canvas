package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

// ListAgentWorkstationCardsByUser 列出当前用户工作区的所有卡片，按 position asc, updated_at asc。
func ListAgentWorkstationCardsByUser(userID string) ([]model.AgentWorkstationCard, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var items []model.AgentWorkstationCard
	err = db.Where("user_id = ?", userID).Order("position asc, updated_at asc").Find(&items).Error
	return items, err
}

// GetAgentWorkstationCardByID 按 ID 查询单张卡片。
func GetAgentWorkstationCardByID(id string) (model.AgentWorkstationCard, bool, error) {
	db, err := DB()
	if err != nil {
		return model.AgentWorkstationCard{}, false, err
	}
	item := model.AgentWorkstationCard{}
	err = db.Where("id = ?", id).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.AgentWorkstationCard{}, false, nil
	}
	return item, err == nil, err
}

// GetAgentWorkstationCardByUserAndAgent 用于 upsert：按 (user_id, agent_id) 查找已有卡片。
func GetAgentWorkstationCardByUserAndAgent(userID string, agentID string) (model.AgentWorkstationCard, bool, error) {
	db, err := DB()
	if err != nil {
		return model.AgentWorkstationCard{}, false, err
	}
	item := model.AgentWorkstationCard{}
	err = db.Where("user_id = ? AND agent_id = ?", userID, agentID).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.AgentWorkstationCard{}, false, nil
	}
	return item, err == nil, err
}

// SaveAgentWorkstationCard 新建或更新卡片，更新时保留原 created_at。
func SaveAgentWorkstationCard(item model.AgentWorkstationCard) (model.AgentWorkstationCard, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	saved, ok, err := GetAgentWorkstationCardByID(item.ID)
	if err != nil {
		return item, err
	}
	if ok && item.CreatedAt == "" {
		item.CreatedAt = saved.CreatedAt
	}
	return item, db.Save(&item).Error
}

// DeleteAgentWorkstationCard 删除单张卡片。
func DeleteAgentWorkstationCard(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.AgentWorkstationCard{}, "id = ?", id).Error
}
