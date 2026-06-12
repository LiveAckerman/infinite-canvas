package config

import (
	"github.com/caarlos0/env/v11"
	"github.com/joho/godotenv"
)

type Config struct {
	Port           string `env:"PORT" envDefault:"8080"`
	AdminUsername  string `env:"ADMIN_USERNAME" envDefault:"admin"`
	AdminPassword  string `env:"ADMIN_PASSWORD" envDefault:"infinite-canvas"`
	JWTSecret      string `env:"JWT_SECRET" envDefault:"infinite-canvas"`
	JWTExpireHours int    `env:"JWT_EXPIRE_HOURS" envDefault:"168"`
	StorageDriver  string `env:"STORAGE_DRIVER" envDefault:"sqlite"`
	DatabaseDSN    string `env:"DATABASE_DSN" envDefault:"data/infinite-canvas.db"`
	ImageDir       string `env:"IMAGE_DIR" envDefault:"data/uploads"`
	// 图片二进制后端：默认 "local"（保留向后兼容，写到 ImageDir）；设为 "r2" 时落到 Cloudflare R2 桶。
	// 切到 r2 前需要把存量图片迁过去（`go run . --migrate-images`），DB 里 Image.Path 不变（相对路径即对象 key）。
	ImageBackend string `env:"IMAGE_BACKEND" envDefault:"local"`
	// R2 配置：ImageBackend=r2 时必填。Endpoint 形如 https://<account-id>.r2.cloudflarestorage.com
	// 不要把这些写进 .env.example / 任何 committed 文件，仅放生产 .env / 部署密文里。
	R2Endpoint        string `env:"R2_ENDPOINT"`
	R2AccessKeyID     string `env:"R2_ACCESS_KEY_ID"`
	R2SecretAccessKey string `env:"R2_SECRET_ACCESS_KEY"`
	R2Bucket          string `env:"R2_BUCKET"`
	R2Region          string `env:"R2_REGION" envDefault:"auto"`
	// 设置后 GET /api/images/:id 不再从 R2 代理流二进制，而是直接 302 重定向到
	// `${ImageCDNBase}/${image.Path}`。配合 Cloudflare R2 自定义域 + 边缘缓存，
	// 国内用户拉历史图基本走 HK POP，几十到几百毫秒。形如 https://cdn.lijiwang.top
	// （末尾不要带斜杠；带了也会被去掉）。
	ImageCDNBase string `env:"IMAGE_CDN_BASE"`
}

var Cfg Config

func Load() error {
	_ = godotenv.Load()
	return env.Parse(&Cfg)
}
