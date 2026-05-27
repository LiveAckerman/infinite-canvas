package model

// PipelineRunStatus 一条执行流程的总状态。
//   - queued: 客户端已建好，等浏览器并发槽位（cap=3）放行才会跑
//   - running: 正在跑某一步
//   - paused: 之前 running 中浏览器关掉 / 刷新 / 切设备 → 后端没人继续推进了；
//     用户在任意 tab 打开详情点「继续」可以恢复
//   - success / partial / failed: 终态
type PipelineRunStatus string

const (
	PipelineRunStatusQueued  PipelineRunStatus = "queued"
	PipelineRunStatusRunning PipelineRunStatus = "running"
	PipelineRunStatusPaused  PipelineRunStatus = "paused"
	PipelineRunStatusSuccess PipelineRunStatus = "success"
	PipelineRunStatusPartial PipelineRunStatus = "partial"
	PipelineRunStatusFailed  PipelineRunStatus = "failed"
)

// PipelineRunStepStatus 单步状态。idle = 还没轮到，其余跟图生图本身的术语一致。
type PipelineRunStepStatus string

const (
	PipelineRunStepIdle    PipelineRunStepStatus = "idle"
	PipelineRunStepRunning PipelineRunStepStatus = "running"
	PipelineRunStepSuccess PipelineRunStepStatus = "success"
	PipelineRunStepFailed  PipelineRunStepStatus = "failed"
)

// PipelineRunStepSnapshot 上一次成功跑的「输入 key + 附加说明」快照，
// 用于判定 stale —— 当前输入 / 附加说明与快照不一致 → 下游可能需要重做。
//
// InputSource 标记上一次实际跑的输入是哪种来源：
//   - "upstream"（或空，兼容老数据）：用 computeInputKey 算出来的「上游产物 / seed / 手动覆盖」
//   - "iterate"：把本步自己的旧 outputKey 当成输入做的迭代微调（用户加了附加说明 + 本步已有产物时触发）
// 详情页据此判断 stale：iterate 模式下只看 extraNote 变没变，不看 upstream，
// 否则用户一旦走过一次迭代，永远会被误判为「上游已变更」。
type PipelineRunStepSnapshot struct {
	InputKey    string `json:"inputKey"`
	ExtraNote   string `json:"extraNote"`
	InputSource string `json:"inputSource,omitempty"`
}

// PipelineRunStep 单步运行状态（落库的形态）。
// 字段命名跟前端 StepRuntime 对齐，前后端可直接互转。
//
// 注意：AgentNameSnap / AvatarUrlSnap 是「创建 run 时的角色快照」，
// 即使后续该角色被改名 / 删头像 / 删整条角色，run 详情里依然能完整渲染。
type PipelineRunStep struct {
	StepID            string                   `json:"stepId"`
	AgentID           string                   `json:"agentId"`
	AgentNameSnap     string                   `json:"agentName"`
	AvatarUrlSnap     string                   `json:"avatarUrl"`
	ExtraNote         string                   `json:"extraNote"`
	Status            PipelineRunStepStatus    `json:"status"`
	ManualOverrideKey string                   `json:"manualOverrideKey,omitempty"`
	OutputKey         string                   `json:"outputKey,omitempty"`
	LastRunSnapshot   *PipelineRunStepSnapshot `json:"lastRunSnapshot,omitempty"`
	ErrorMessage      string                   `json:"errorMessage,omitempty"`
	DurationMs        int                      `json:"durationMs,omitempty"`
}

// PipelineRun 一次执行流程的完整记录。
type PipelineRun struct {
	ID               string            `json:"id" gorm:"primaryKey"`
	UserID           string            `json:"userId" gorm:"index"`
	PipelineID       string            `json:"pipelineId" gorm:"index"`
	PipelineNameSnap string            `json:"pipelineName"`
	SeedKey          string            `json:"seedKey"`
	Steps            []PipelineRunStep `json:"steps" gorm:"serializer:json"`
	Status           PipelineRunStatus `json:"status" gorm:"index"`
	CreatedAt        string            `json:"createdAt"`
	UpdatedAt        string            `json:"updatedAt"`
}

// PipelineRunList 列表分页结果。
type PipelineRunList struct {
	Items []PipelineRun `json:"items"`
	Total int           `json:"total"`
}
