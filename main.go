package main

import (
	"log"
	"os"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/router"
	"github.com/basketikun/infinite-canvas/service"
)

func main() {
	if err := config.Load(); err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(config.Cfg.ImageDir, 0o755); err != nil {
		log.Fatal(err)
	}
	if err := service.EnsureDefaultAdmin(); err != nil {
		log.Fatal(err)
	}
	// 把上次没跑完的后端生图任务接着跑（服务重启 / 崩溃后恢复）；旧的遗留 running 记录顺手收敛终态。
	service.ResumeRunningGenerations()
	log.Fatal(router.New().Run(":" + config.Cfg.Port))
}
