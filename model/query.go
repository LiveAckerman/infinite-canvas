package model

const MaxPageSize = 500

// Query 列表筛选和分页参数。
type Query struct {
	Keyword    string
	Tags       []string
	Category   string
	Type       string
	Visibility string
	UserID     string
	// AgentID 仅用于 /api/generations 按角色筛选：非空表示只看这个 agent 的生成记录。
	AgentID string
	// HasAgent 仅用于 /api/generations：非空表示「只看来自角色工作台的记录」（agent_id 非空）。
	// 跟 AgentID 同时存在时 AgentID 生效。
	HasAgent bool
	Page     int
	PageSize int
}

func (q *Query) Normalize() {
	if q.Page < 1 {
		q.Page = 1
	}
	if q.PageSize < 1 {
		q.PageSize = 20
	}
	if q.PageSize > MaxPageSize {
		q.PageSize = MaxPageSize
	}
}

func (q *Query) Offset() int {
	return (q.Page - 1) * q.PageSize
}
