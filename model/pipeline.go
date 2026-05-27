package model

// Pipeline 用户保存的「角色流水线」：一组角色 + 顺序 + 每步默认附加说明的命名编排。
// 执行产物（每步的输出图、状态）不落库——产物是 session 内的，关掉页面就重跑，
// 跟单角色工作台一致。这里只保留「下一次怎么编排」需要的最小持久化数据。
type Pipeline struct {
	ID          string         `json:"id" gorm:"primaryKey"`
	UserID      string         `json:"userId" gorm:"index"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Steps       []PipelineStep `json:"steps" gorm:"serializer:json"`
	CreatedAt   string         `json:"createdAt"`
	UpdatedAt   string         `json:"updatedAt"`
}

// PipelineStep 一条流水线的某一步：用哪个角色 + 该步默认附加说明。
// StepID 是客户端生成的稳定 ID（拖拽排序、单步重做都按这个 key 定位），
// 跟 angent.id 不同；同一个角色在一条流水线里可以出现多次，每次有不同的 StepID。
type PipelineStep struct {
	StepID    string `json:"stepId"`
	AgentID   string `json:"agentId"`
	ExtraNote string `json:"extraNote"`
}

// PipelineList 流水线列表（不分页，一个用户的流水线数量本来就不会很多）。
type PipelineList struct {
	Items []Pipeline `json:"items"`
	Total int        `json:"total"`
}
