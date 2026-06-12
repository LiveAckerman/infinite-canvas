package model

// AgentWorkstationCardStatus 跟前端 WorkstationStatus 对齐。
// running：后端任务驱动模式下，task 真的在后端跑（关联 RunningGenerationID 指向那条 generation），
// 页面刷新后照样能查到状态、续上轮询，不再丢进度。
type AgentWorkstationCardStatus string

const (
	AgentWorkstationCardStatusIdle    AgentWorkstationCardStatus = "idle"
	AgentWorkstationCardStatusRunning AgentWorkstationCardStatus = "running"
	AgentWorkstationCardStatusSuccess AgentWorkstationCardStatus = "success"
	AgentWorkstationCardStatusFailed  AgentWorkstationCardStatus = "failed"
)

// AgentWorkstationCard /agents 并行模式工作区里的一张卡片状态。
// (UserID, AgentID) 唯一：每个角色在工作区里最多出现一次（跟前端 addToWorkspace 的语义一致）。
// 持久化用户输入（ReferenceKeys / ExtraNote）+ 上一次跑出来的产物（OutputKey / Status / 元信息）；
// 跨设备登录同一账号会自动恢复整套工作区。
type AgentWorkstationCard struct {
	ID            string                     `json:"id" gorm:"primaryKey"`
	UserID        string                     `json:"userId" gorm:"index"`
	AgentID       string                     `json:"agentId" gorm:"index"`
	Position      int                        `json:"position"`                                       // 列表里的排序，越小越靠前
	ReferenceKeys []string                   `json:"referenceKeys,omitempty" gorm:"serializer:json"` // 用户上传的原图，最多 9 张
	ExtraNote     string                     `json:"extraNote,omitempty"`
	OutputKey     string                     `json:"outputKey,omitempty"`
	Status        AgentWorkstationCardStatus `json:"status"`
	// RunningGenerationID Status=running 时关联的那条 generation id（POST /api/generations/run 返回）。
	// 前端轮询这条 generation 拿进度；刷新 / 切走再回来都能据此续上轮询。终态时清空。
	RunningGenerationID string `json:"runningGenerationId,omitempty"`
	ErrorMessage  string                     `json:"errorMessage,omitempty"`
	DurationMs    int                        `json:"durationMs,omitempty"`
	CreatedAt     string                     `json:"createdAt"`
	UpdatedAt     string                     `json:"updatedAt"`
}

// AgentWorkstationCardList 工作区卡片列表。
type AgentWorkstationCardList struct {
	Items []AgentWorkstationCard `json:"items"`
	Total int                    `json:"total"`
}
