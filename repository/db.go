package repository

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/glebarez/sqlite"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

var promptCategories = []model.PromptCategory{
	{Category: "system", Name: "系统", Description: "系统提示词分类"},
	{Category: "gpt-image-2-prompts", Name: "GPT Image 2 Prompts", Description: "EvoLinkAI 的 GPT Image 2 案例提示词分类", GithubURL: "https://github.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts", Remote: true},
	{Category: "awesome-gpt-image", Name: "Awesome GPT Image", Description: "ZeroLu 的中文 GPT Image 提示词分类", GithubURL: "https://github.com/ZeroLu/awesome-gpt-image", Remote: true},
	{Category: "awesome-gpt4o-image-prompts", Name: "Awesome GPT4o Image Prompts", Description: "ImgEdify 的 GPT-4o 图像提示词分类", GithubURL: "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts", Remote: true},
	{Category: "youmind-gpt-image-2", Name: "YouMind GPT Image 2", Description: "YouMind OpenLab 的 GPT Image 2 中文提示词分类", GithubURL: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2", Remote: true},
	{Category: "youmind-nano-banana-pro", Name: "YouMind Nano Banana Pro", Description: "YouMind OpenLab 的 Nano Banana Pro 中文提示词分类", GithubURL: "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts", Remote: true},
}

var (
	db     *gorm.DB
	dbOnce sync.Once
	dbErr  error
)

// DB 初始化并返回全局数据库连接。
func DB() (*gorm.DB, error) {
	dbOnce.Do(func() {
		driver := strings.ToLower(strings.TrimSpace(config.Cfg.StorageDriver))
		if driver == "" {
			driver = "sqlite"
		}
		dsn := config.Cfg.DatabaseDSN
		if driver == "sqlite" && dsn != ":memory:" {
			_ = os.MkdirAll(filepath.Dir(dsn), 0755)
		}
		db, dbErr = gorm.Open(dialector(driver, dsn), &gorm.Config{})
		if dbErr != nil {
			return
		}
		dbErr = db.AutoMigrate(
			&model.User{},
			&model.Prompt{},
			&model.Asset{},
			&model.AIConfig{},
			&model.Canvas{},
			&model.Generation{},
			&model.CreditLog{},
			&model.Image{},
			&model.Agent{},
			&model.AgentWorkstationCard{},
			&model.Pipeline{},
			&model.PipelineRun{},
			&model.PipelineBatch{},
			&model.PipelineBatchTemplate{},
		)
		if dbErr == nil {
			backfillAgentWorkstationReferenceKeys(db)
		}
	})
	return db, dbErr
}

// backfillAgentWorkstationReferenceKeys 把 agent_workstation_cards 的老单图列 reference_key
// 迁进新的 JSON 数组列 reference_keys。一次性、幂等：只在 reference_keys 为空且老列非空时补。
// 全新库没有 reference_key 列（SELECT 直接报错），捕获后跳过。新代码不再写 reference_key，
// 所以补过一次后这条查询就再也命中不到了。
func backfillAgentWorkstationReferenceKeys(db *gorm.DB) {
	type legacyRow struct {
		ID           string
		ReferenceKey string
	}
	var rows []legacyRow
	err := db.Table("agent_workstation_cards").
		Where("reference_key IS NOT NULL AND reference_key <> ''").
		Where("(reference_keys IS NULL OR reference_keys = '' OR reference_keys = 'null')").
		Select("id, reference_key").
		Scan(&rows).Error
	if err != nil || len(rows) == 0 {
		return // 老列不存在（全新库）/ 无需迁移
	}
	migrated := 0
	for _, r := range rows {
		keysJSON, e := json.Marshal([]string{r.ReferenceKey})
		if e != nil {
			continue
		}
		if e := db.Table("agent_workstation_cards").
			Where("id = ?", r.ID).
			Update("reference_keys", string(keysJSON)).Error; e != nil {
			log.Printf("backfill workstation reference_keys %s failed: %v", r.ID, e)
			continue
		}
		migrated++
	}
	if migrated > 0 {
		log.Printf("backfilled %d agent_workstation_cards reference_key -> reference_keys", migrated)
	}
}

func dialector(driver string, dsn string) gorm.Dialector {
	switch driver {
	case "mysql":
		return mysql.Open(dsn)
	case "postgres", "postgresql":
		return postgres.Open(dsn)
	default:
		return sqlite.Open(dsn)
	}
}
