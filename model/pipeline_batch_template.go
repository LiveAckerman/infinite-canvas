package model

// PipelineBatchTemplateItem 模板里每条主条的配置。
type PipelineBatchTemplateItem struct {
	PipelineID string `json:"pipelineId"` // 该 position 用哪条流水线模板
	Name       string `json:"name"`       // 该主条的默认名（便于用户上传时分辨「这张图给哪条主条」）
}

// PipelineBatchTemplateSourceRef 模板里的后处理 source 引用。
// 模板没有具体 run，所以用 itemIndex（模板内主条序号）；
// 实际创建 batch 时由后端转换成具体 runId。
type PipelineBatchTemplateSourceRef struct {
	ItemIndex int `json:"itemIndex"` // 模板内主条序号（0 .. ItemCount-1）
	StepIndex int `json:"stepIndex"` // -1 = seed；0+ = 第 N 步产物
}

// PipelineBatchTemplatePost 模板里的后处理配置。
type PipelineBatchTemplatePost struct {
	Name     string                           `json:"name"`     // 后处理展示名
	Sources  []PipelineBatchTemplateSourceRef `json:"sources"`  // 共享给每个 agent 的 references 来源
	AgentIDs []string                         `json:"agentIds"` // 每个 agent 独立用 sources 跑一次（无顺序）
}

// PipelineBatchTemplate 批处理模板：保存「N 条主条选哪些流水线模板 + 后处理配置」的复用单元。
// 后续用户只需要选模板 + 上传 N 张图，就能直接创建一个 batch。
type PipelineBatchTemplate struct {
	ID          string                      `json:"id" gorm:"primaryKey"`
	UserID      string                      `json:"userId" gorm:"index"`
	Name        string                      `json:"name"`
	Description string                      `json:"description"`
	ItemCount   int                         `json:"itemCount"` // = len(Items)
	Items       []PipelineBatchTemplateItem `json:"items" gorm:"serializer:json"`
	// Post 为空表示该模板不启用后处理
	Post      *PipelineBatchTemplatePost `json:"post,omitempty" gorm:"serializer:json"`
	CreatedAt string                     `json:"createdAt"`
	UpdatedAt string                     `json:"updatedAt"`
}

// PipelineBatchTemplateList 模板列表分页结果。
type PipelineBatchTemplateList struct {
	Items []PipelineBatchTemplate `json:"items"`
	Total int                     `json:"total"`
}
