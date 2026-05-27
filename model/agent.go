package model

// Agent 用户自定义的「角色」：把一段固定的提示词、默认尺寸/质量、头像和名字打包，
// 在角色工作台里挂多列同页并行执行（一个角色一列，各自上传图、各自跑、互不影响）。
//
// 字段约定：
//   - AvatarURL 为空时前端用 Name 首字 + 自动取色做文字头像；非空走 useImageUploader 存到图床。
//   - SystemPrompt 是核心，调上游时拼在用户附加说明前面（系统/用户两段，prompt 字段 join）。
//   - DefaultSize / DefaultQuality 为空时回落到用户 AiConfig 的全局默认。
//   - ReferenceImageKeys 是角色绑定的「固定参考图」（可选，最多 3 张）：每次该角色生图都会把
//     它们和用户在工作台上传的原图一起作为 references 发到上游 /v1/images/edits。仅存图床的
//     storageKey，前端展示时统一走 imageUrl(key) → /api/images/{key} 直链。
type Agent struct {
	ID                 string   `json:"id" gorm:"primaryKey"`
	UserID             string   `json:"userId" gorm:"index"`
	Name               string   `json:"name"`
	AvatarURL          string   `json:"avatarUrl"`
	Description        string   `json:"description"`
	SystemPrompt       string   `json:"systemPrompt"`
	DefaultSize        string   `json:"defaultSize"`
	DefaultQuality     string   `json:"defaultQuality"`
	ReferenceImageKeys []string `json:"referenceImageKeys" gorm:"serializer:json"`
	UsageCount         int      `json:"usageCount"`
	CreatedAt          string   `json:"createdAt"`
	UpdatedAt          string   `json:"updatedAt"`
}

// AgentList 角色列表（角色工作台一次性拉，不分页）。
type AgentList struct {
	Items []Agent `json:"items"`
	Total int     `json:"total"`
}
