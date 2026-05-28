package model

// AgentWorkstationCardStatus 跟前端 WorkstationStatus 对齐（除掉 running，
// running 不入库——页面挂掉后 task 没法续跑，恢复时全部按 idle）。
type AgentWorkstationCardStatus string

const (
	AgentWorkstationCardStatusIdle    AgentWorkstationCardStatus = "idle"
	AgentWorkstationCardStatusSuccess AgentWorkstationCardStatus = "success"
	AgentWorkstationCardStatusFailed  AgentWorkstationCardStatus = "failed"
)

// AgentWorkstationCard /agents 并行模式工作区里的一张卡片状态。
// (UserID, AgentID) 唯一：每个角色在工作区里最多出现一次（跟前端 addToWorkspace 的语义一致）。
// 持久化用户输入（ReferenceKey / ExtraNote）+ 上一次跑出来的产物（OutputKey / Status / 元信息）；
// 跨设备登录同一账号会自动恢复整套工作区。
type AgentWorkstationCard struct {
	ID           string                     `json:"id" gorm:"primaryKey"`
	UserID       string                     `json:"userId" gorm:"index"`
	AgentID      string                     `json:"agentId" gorm:"index"`
	Position     int                        `json:"position"` // 列表里的排序，越小越靠前
	ReferenceKey string                     `json:"referenceKey,omitempty"`
	ExtraNote    string                     `json:"extraNote,omitempty"`
	OutputKey    string                     `json:"outputKey,omitempty"`
	Status       AgentWorkstationCardStatus `json:"status"`
	ErrorMessage string                     `json:"errorMessage,omitempty"`
	DurationMs   int                        `json:"durationMs,omitempty"`
	CreatedAt    string                     `json:"createdAt"`
	UpdatedAt    string                     `json:"updatedAt"`
}

// AgentWorkstationCardList 工作区卡片列表。
type AgentWorkstationCardList struct {
	Items []AgentWorkstationCard `json:"items"`
	Total int                    `json:"total"`
}
