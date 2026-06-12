package service

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

// MigrateImagesToR2 把本地磁盘 IMAGE_DIR 下的图片对象搬到当前配置的 R2 桶。
// 调用前提：IMAGE_BACKEND=r2 + R2_* 配置全齐；本地 IMAGE_DIR 还保留着待迁的文件。
//
// 行为：
//   - 遍历 DB 里所有 Image 行，逐张读本地文件 → r2.Put（对象 key 沿用 Image.Path）。
//   - 已存在的对象（HEAD / 失败重试）默认覆盖，保证最终一致。
//   - 本地文件缺失但 DB 有行 → 记一条 warn，跳过；DB 有也没法补救。
//   - dryRun=true 只打印计划不实际上传。
//
// 这是个一次性操作，不进 router；通过 `go run . --migrate-images [--dry-run]` 触发。
// 完成后操作员可以手动 rm -rf data/uploads，确认所有图能正常显示后再清。
func MigrateImagesToR2(dryRun bool) error {
	backend := strings.ToLower(strings.TrimSpace(config.Cfg.ImageBackend))
	if backend != "r2" {
		return fmt.Errorf("当前 IMAGE_BACKEND=%q，不是 r2；请先设置 IMAGE_BACKEND=r2 + R2_* 再跑迁移", backend)
	}
	r2, err := newR2ImageStore()
	if err != nil {
		return fmt.Errorf("R2 初始化失败：%w", err)
	}
	localDir := config.Cfg.ImageDir
	if localDir == "" {
		return errors.New("IMAGE_DIR 未配置，无法确定本地源")
	}

	db, err := repository.DB()
	if err != nil {
		return err
	}
	var images []model.Image
	if err := db.Find(&images).Error; err != nil {
		return err
	}
	total := len(images)
	log.Printf("[migrate] DB 共 %d 张图片，目标 R2 桶 %s", total, config.Cfg.R2Bucket)
	if dryRun {
		log.Printf("[migrate] dry-run，只打印计划不实际上传")
	}

	var uploaded, skippedMissing, failed int
	for i, image := range images {
		if image.Path == "" {
			skippedMissing++
			log.Printf("[migrate] %d/%d %s 跳过：DB 行没有 Path", i+1, total, image.ID)
			continue
		}
		abs := filepath.Join(localDir, filepath.FromSlash(image.Path))
		data, err := os.ReadFile(abs)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				skippedMissing++
				log.Printf("[migrate] %d/%d %s 跳过：本地文件不存在 (%s)", i+1, total, image.ID, abs)
				continue
			}
			failed++
			log.Printf("[migrate] %d/%d %s 读本地失败：%v", i+1, total, image.ID, err)
			continue
		}
		if dryRun {
			log.Printf("[migrate] %d/%d %s → r2://%s/%s (%d bytes) [dry-run]", i+1, total, image.ID, config.Cfg.R2Bucket, image.Path, len(data))
			uploaded++
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		err = r2.Put(ctx, image.Path, data, image.MimeType)
		cancel()
		if err != nil {
			failed++
			log.Printf("[migrate] %d/%d %s R2 上传失败：%v", i+1, total, image.ID, err)
			continue
		}
		uploaded++
		if (i+1)%50 == 0 || i+1 == total {
			log.Printf("[migrate] 进度 %d/%d（已传 %d，本地缺失 %d，失败 %d）", i+1, total, uploaded, skippedMissing, failed)
		}
	}
	log.Printf("[migrate] 完成：总 %d，成功 %d，本地缺失 %d，失败 %d", total, uploaded, skippedMissing, failed)
	if failed > 0 {
		return fmt.Errorf("有 %d 张失败，请检查日志", failed)
	}
	return nil
}
