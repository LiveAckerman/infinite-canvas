package model

// PromptVisibility 控制提示词的可见性 / 审核状态。
//   - public: 任何登录用户在 /prompts 列表能看到（管理员后台直接发布的、用户提交后通过的）
//   - pending: 用户从生图记录提交进来，待 admin 审核；前台用户列表不可见
//   - rejected: admin 审核未通过，前台不可见
//   - 空字符串视为 public（兼容历史数据）
type PromptVisibility string

const (
	PromptVisibilityPublic   PromptVisibility = "public"
	PromptVisibilityPending  PromptVisibility = "pending"
	PromptVisibilityRejected PromptVisibility = "rejected"
)

// Prompt 提示词记录。
type Prompt struct {
	ID          string           `json:"id" gorm:"primaryKey"`
	Title       string           `json:"title"`
	CoverURL    string           `json:"coverUrl"`
	Prompt      string           `json:"prompt"`
	Tags        []string         `json:"tags" gorm:"serializer:json"`
	Category    string           `json:"category" gorm:"index"`
	GithubURL   string           `json:"githubUrl" gorm:"-"`
	Preview     string           `json:"preview"`
	Visibility  PromptVisibility `json:"visibility" gorm:"index"`
	SubmitterID string           `json:"submitterId" gorm:"index"`
	CreatedAt   string           `json:"createdAt"`
	UpdatedAt   string           `json:"updatedAt"`
}

// PromptList 提示词分页结果。
type PromptList struct {
	Items      []Prompt `json:"items"`
	Tags       []string `json:"tags"`
	Categories []string `json:"categories"`
	Total      int      `json:"total"`
}

// PromptCategory 提示词分类。
type PromptCategory struct {
	Category    string `json:"category" gorm:"primaryKey"`
	Name        string `json:"name"`
	Description string `json:"description"`
	GithubURL   string `json:"githubUrl"`
	Remote      bool   `json:"remote"`
	UpdatedAt   string `json:"updatedAt"`
}
