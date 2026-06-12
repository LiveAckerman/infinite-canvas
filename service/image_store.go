package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
)

// imageStore 抽象图片二进制后端 —— 本地文件系统或 Cloudflare R2（任何 S3 兼容也行）。
// DB 里 Image.Path 是后端无关的相对 key（形如 "<userId>/<id>.png"），存储后端只看 key。
// 切换后端不需要改 DB，只迁数据。
type imageStore interface {
	// Put 写入完整内容；mimeType 用作元信息（local 后端忽略，r2 后端写到 ContentType）。
	Put(ctx context.Context, key string, data []byte, mimeType string) error
	// Open 按 key 取一个可读 stream + 已知的字节数（-1 表示未知）。caller 负责 Close。
	Open(ctx context.Context, key string) (io.ReadCloser, int64, error)
	// Delete 删除 key 指向的对象；不存在不算错。
	Delete(ctx context.Context, key string) error
	// Backend 名字，用于日志 / migrate 命令做防御。
	Backend() string
}

var (
	defaultStoreOnce sync.Once
	defaultStore     imageStore
	defaultStoreErr  error
)

// ImageStore 返回按配置选好的后端实例。第一次调用时初始化，后续复用。
// 启动失败（R2 配置不全 / 证书错）这里返回 err，调用方决定怎么处理。
func ImageStore() (imageStore, error) {
	defaultStoreOnce.Do(func() {
		backend := strings.ToLower(strings.TrimSpace(config.Cfg.ImageBackend))
		switch backend {
		case "", "local":
			defaultStore = &localImageStore{root: config.Cfg.ImageDir}
		case "r2", "s3":
			s, err := newR2ImageStore()
			if err != nil {
				defaultStoreErr = err
				return
			}
			defaultStore = s
		default:
			defaultStoreErr = fmt.Errorf("未知 IMAGE_BACKEND: %q（应为 local 或 r2）", backend)
		}
	})
	return defaultStore, defaultStoreErr
}

// localImageStore 把对象存到 root 目录下，相对路径就是 key。
type localImageStore struct {
	root string
}

func (s *localImageStore) Backend() string { return "local" }

func (s *localImageStore) abs(key string) string {
	return filepath.Join(s.root, filepath.FromSlash(key))
}

func (s *localImageStore) Put(_ context.Context, key string, data []byte, _ string) error {
	abs := s.abs(key)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	return os.WriteFile(abs, data, 0o644)
}

func (s *localImageStore) Open(_ context.Context, key string) (io.ReadCloser, int64, error) {
	f, err := os.Open(s.abs(key))
	if err != nil {
		return nil, 0, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, 0, err
	}
	return f, info.Size(), nil
}

func (s *localImageStore) Delete(_ context.Context, key string) error {
	err := os.Remove(s.abs(key))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// r2ImageStore 把对象存到 Cloudflare R2（S3 兼容）。
type r2ImageStore struct {
	client *s3.Client
	bucket string
}

func (s *r2ImageStore) Backend() string { return "r2" }

func newR2ImageStore() (*r2ImageStore, error) {
	cfg := config.Cfg
	if cfg.R2Endpoint == "" || cfg.R2Bucket == "" || cfg.R2AccessKeyID == "" || cfg.R2SecretAccessKey == "" {
		return nil, errors.New("R2 配置不全：需要 R2_ENDPOINT / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY")
	}
	region := cfg.R2Region
	if region == "" {
		region = "auto"
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(
		context.Background(),
		awsconfig.WithRegion(region),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(cfg.R2AccessKeyID, cfg.R2SecretAccessKey, "")),
	)
	if err != nil {
		return nil, fmt.Errorf("加载 AWS 配置失败：%w", err)
	}
	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.BaseEndpoint = &cfg.R2Endpoint
		// R2 的对象 key 不当作路径分隔，UsePathStyle 必须开 —— Endpoint 已经包含 account id，不需要 virtual host。
		o.UsePathStyle = true
	})
	return &r2ImageStore{client: client, bucket: cfg.R2Bucket}, nil
}

func (s *r2ImageStore) Put(ctx context.Context, key string, data []byte, mimeType string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      &s.bucket,
		Key:         &key,
		Body:        bytes.NewReader(data),
		ContentType: nonEmptyPtr(mimeType),
	})
	return err
}

func (s *r2ImageStore) Open(ctx context.Context, key string) (io.ReadCloser, int64, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: &s.bucket,
		Key:    &key,
	})
	if err != nil {
		return nil, 0, err
	}
	size := int64(-1)
	if out.ContentLength != nil {
		size = *out.ContentLength
	}
	return out.Body, size, nil
}

func (s *r2ImageStore) Delete(ctx context.Context, key string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: &s.bucket,
		Key:    &key,
	})
	// R2 / S3 都把删除不存在视作成功，但少数 SDK 边界情况会回 NoSuchKey —— 显式吞掉。
	if err != nil {
		var apiErr smithy.APIError
		if errors.As(err, &apiErr) && (apiErr.ErrorCode() == "NoSuchKey" || apiErr.ErrorCode() == "404") {
			return nil
		}
	}
	return err
}

func nonEmptyPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ImageObjectKey 返回某条 Image 在 store 里的相对 key，跟 SaveImage 写入时一致。
// 给 handler / migrate 用，不直接拼 ImageDir 路径。
func ImageObjectKey(image model.Image) string {
	return image.Path
}

// OpenImageObject 按 store 抽象拿到二进制流；不存在 / 网络错都通过 err 返回。
// caller 必须 Close 返回的 io.ReadCloser。
func OpenImageObject(image model.Image) (io.ReadCloser, int64, error) {
	store, err := ImageStore()
	if err != nil {
		return nil, 0, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	rc, size, err := store.Open(ctx, ImageObjectKey(image))
	// 这里不 defer cancel —— 调用方读流时还需要 ctx 不被取消。我们用 wrapper 在 Close 时一起 cancel。
	if err != nil {
		cancel()
		return nil, 0, err
	}
	return &ctxClosingReadCloser{ReadCloser: rc, cancel: cancel}, size, nil
}

// ctxClosingReadCloser 在 Close 时把读流连同 ctx cancel 一起释放。
type ctxClosingReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c *ctxClosingReadCloser) Close() error {
	err := c.ReadCloser.Close()
	c.cancel()
	return err
}

// ReadImageBytes 读全字节，给图片代理 / migrate 用。
func ReadImageBytes(image model.Image) ([]byte, error) {
	rc, _, err := OpenImageObject(image)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

// IsImageNotFound 把后端无关的「对象不存在」错统一识别。
func IsImageNotFound(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		code := apiErr.ErrorCode()
		if code == "NoSuchKey" || code == "404" || code == "NotFound" {
			return true
		}
	}
	var respErr interface{ HTTPStatusCode() int }
	if errors.As(err, &respErr) && respErr.HTTPStatusCode() == http.StatusNotFound {
		return true
	}
	return false
}
