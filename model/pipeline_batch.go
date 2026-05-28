package model

// PipelineBatchStatus 一个批量任务的总状态。
//   - queued：刚建好，主条都是 paused，等用户「全部启动」
//   - running：主条 / post 至少一条在跑或排队
//   - post_waiting：主条全部 done，但 sources 里某些主条步骤产物缺失，待用户决策
//                  （继续跳过缺失 / 暂停去补救 / 跳过后处理直接 done）
//   - success：主条 + post 全部 success
//   - partial：主条或 post 至少一条 failed / partial，其余 ok
//   - failed：主条全部 failed（极端情况，post 不会触发）
type PipelineBatchStatus string

const (
	PipelineBatchStatusQueued      PipelineBatchStatus = "queued"
	PipelineBatchStatusRunning     PipelineBatchStatus = "running"
	PipelineBatchStatusPostWaiting PipelineBatchStatus = "post_waiting"
	PipelineBatchStatusSuccess     PipelineBatchStatus = "success"
	PipelineBatchStatusPartial     PipelineBatchStatus = "partial"
	PipelineBatchStatusFailed      PipelineBatchStatus = "failed"
)

// PipelineBatch 一次批量任务的元信息（具体的 main / post runs 通过
// pipeline_runs.batch_id 关联，不在这个表里冗余存）。
type PipelineBatch struct {
	ID         string              `json:"id" gorm:"primaryKey"`
	UserID     string              `json:"userId" gorm:"index"`
	Name       string              `json:"name"`
	TotalCount int                 `json:"totalCount"` // 主条数（创建时锁定）
	Status     PipelineBatchStatus `json:"status" gorm:"index"`
	// PostEnabled 创建时是否启用了后处理（决定查询关联 post run 时的预期）
	PostEnabled bool `json:"postEnabled"`
	// PostName 后处理 run 的展示名；用于 zip 命名等。仅 PostEnabled=true 时有意义。
	PostName  string `json:"postName"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// PipelineBatchListItem 列表项：batch + 聚合的状态计数（不展开 runs）。
type PipelineBatchListItem struct {
	PipelineBatch
	MainTotal     int `json:"mainTotal"`
	MainSuccess   int `json:"mainSuccess"`
	MainFailed    int `json:"mainFailed"`
	MainRunning   int `json:"mainRunning"`
	MainQueued    int `json:"mainQueued"`
	MainPaused    int `json:"mainPaused"`
	PostTotal     int `json:"postTotal"`
	PostSuccess   int `json:"postSuccess"`
	PostFailed    int `json:"postFailed"`
	PostRunning   int `json:"postRunning"`
}

// PipelineBatchList 批量任务列表分页结果。
type PipelineBatchList struct {
	Items []PipelineBatchListItem `json:"items"`
	Total int                     `json:"total"`
}

// PipelineBatchDetail 详情：batch + 展开的 main runs + post runs（如有）。
type PipelineBatchDetail struct {
	Batch    PipelineBatch `json:"batch"`
	MainRuns []PipelineRun `json:"mainRuns"`
	PostRuns []PipelineRun `json:"postRuns"`
}

// PipelineBatchPostDecision 用户在 post_waiting 时的决策。
type PipelineBatchPostDecision string

const (
	// 继续跑后处理，sources 里缺失的 source 在 runner 里跳过
	PipelineBatchDecisionContinue PipelineBatchPostDecision = "continue"
	// 跳过后处理，整批直接 done（按主条成功率判终态）
	PipelineBatchDecisionSkip PipelineBatchPostDecision = "skip"
)
