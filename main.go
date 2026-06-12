package main

import (
	"flag"
	"log"
	"os"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/router"
	"github.com/basketikun/infinite-canvas/service"
)

func main() {
	// 一次性运维命令：迁移 IMAGE_DIR 到 R2。完成后 exit，不起服务。
	migrate := flag.Bool("migrate-images", false, "把 IMAGE_DIR 里的所有图片搬到 R2 桶（需要 IMAGE_BACKEND=r2 + R2_* 配置齐全）")
	dryRun := flag.Bool("dry-run", false, "配合 --migrate-images：只打印计划不实际上传")
	flag.Parse()

	if err := config.Load(); err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(config.Cfg.ImageDir, 0o755); err != nil {
		log.Fatal(err)
	}

	if *migrate {
		if err := service.MigrateImagesToR2(*dryRun); err != nil {
			log.Fatalf("迁移失败：%v", err)
		}
		log.Println("迁移完成。确认线上图片显示正常后，可手动清理本地 IMAGE_DIR。")
		return
	}

	if err := service.EnsureDefaultAdmin(); err != nil {
		log.Fatal(err)
	}
	// 把上次没跑完的后端生图任务接着跑（服务重启 / 崩溃后恢复）；旧的遗留 running 记录顺手收敛终态。
	service.ResumeRunningGenerations()
	log.Fatal(router.New().Run(":" + config.Cfg.Port))
}
