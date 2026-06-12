package service

import (
	"context"
	"errors"
	"mime"
	"path/filepath"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

// 单张图片最大 32 MB，超过则拒绝；按典型生图分辨率绰绰有余，又避免恶意撑爆磁盘。
const maxImageBytes = 32 << 20

// SaveImage 把图片字节写入磁盘 IMAGE_DIR/{userId}/{id}.{ext}，DB 记录 path。
//
// 对普通用户做 500MB 配额检查（admin 跳过）。配额超出时拒绝，让用户先去
// 「管理后台 / 我的素材」清理后再上传，而不是无声占用磁盘。
func SaveImage(userID string, data []byte, mimeType string) (model.Image, error) {
	if userID == "" {
		return model.Image{}, errors.New("请先登录")
	}
	if len(data) == 0 {
		return model.Image{}, errors.New("图片内容为空")
	}
	if len(data) > maxImageBytes {
		return model.Image{}, errors.New("图片超过 32MB")
	}
	// per-user 配额：只对普通用户生效，admin 默认无限。
	if user, ok, _ := repository.GetUserByID(userID); ok && user.Role != model.UserRoleAdmin {
		total, err := userImageTotalBytes(userID)
		if err == nil && total+int64(len(data)) > UserImageQuotaBytes {
			return model.Image{}, errImageQuotaExceeded
		}
	}
	if mimeType == "" {
		mimeType = "image/png"
	}
	id := newID("img")
	// 相对 key（同时是 local 后端的相对路径、r2 后端的对象 key）。slash 一律 forward。
	key := filepath.ToSlash(filepath.Join(safeUserDir(userID), id+extFromMime(mimeType)))
	store, err := ImageStore()
	if err != nil {
		return model.Image{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := store.Put(ctx, key, data, mimeType); err != nil {
		return model.Image{}, err
	}
	image := model.Image{
		ID:        id,
		UserID:    userID,
		MimeType:  mimeType,
		Size:      len(data),
		Path:      key,
		CreatedAt: now(),
	}
	saved, err := repository.SaveImage(image)
	if err != nil {
		// DB 写失败回滚已落盘 / 已上传的对象，避免悬空文件
		_ = store.Delete(context.Background(), key)
		return model.Image{}, err
	}
	return saved, nil
}

// GetImage 取图片元信息，不校验登录态（id 是 uuid，事实上不可枚举）。
// 删除场景用 LoadImageForOwner 做归属检查。
func GetImage(id string) (model.Image, error) {
	image, ok, err := repository.GetImageByID(id)
	if err != nil {
		return model.Image{}, err
	}
	if !ok {
		return model.Image{}, errors.New("图片不存在")
	}
	return image, nil
}

// ImageAbsPath 仅 local 后端有意义；R2 时返回空串，调用方应改用 OpenImageObject。
// 保留是为了兼容历史调用点（已逐步替换成 OpenImageObject）。
func ImageAbsPath(image model.Image) string {
	if strings.ToLower(config.Cfg.ImageBackend) == "r2" {
		return ""
	}
	return filepath.Join(config.Cfg.ImageDir, filepath.FromSlash(image.Path))
}

// GetImageForOwner 取图片元信息并校验 owner，常用于"按 storageKey 引用别人图"
// 的鉴权场景（例如图生图把参考图按 id 传给后端时）。id 不存在或 owner 不匹配都报错。
func GetImageForOwner(userID string, id string) (model.Image, error) {
	if userID == "" {
		return model.Image{}, errors.New("请先登录")
	}
	image, ok, err := repository.GetImageByID(id)
	if err != nil {
		return model.Image{}, err
	}
	if !ok {
		return model.Image{}, errors.New("参考图不存在")
	}
	if image.UserID != userID {
		return model.Image{}, errors.New("参考图无权访问")
	}
	return image, nil
}

// DeleteImage 必须是 owner 才能删；同步删磁盘文件。
func DeleteImage(userID string, id string) error {
	image, ok, err := repository.GetImageByID(id)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	if image.UserID != userID {
		return errors.New("权限不足")
	}
	return deleteImageInternal(image)
}

// deleteImageInternal 不做 owner 校验的删除（供 admin 孤儿清理、级联删除等使用）。
// 同步删 DB 行 + 存储后端对象，对象不存在不报错。
func deleteImageInternal(image model.Image) error {
	if err := repository.DeleteImage(image.ID); err != nil {
		return err
	}
	if image.Path != "" {
		if store, err := ImageStore(); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			_ = store.Delete(ctx, image.Path)
			cancel()
		}
	}
	return nil
}

func safeUserDir(userID string) string {
	clean := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		return '_'
	}, userID)
	if clean == "" {
		clean = "guest"
	}
	return clean
}

func extFromMime(mimeType string) string {
	mimeType = strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	switch mimeType {
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	}
	if exts, err := mime.ExtensionsByType(mimeType); err == nil && len(exts) > 0 {
		return exts[0]
	}
	return ".bin"
}
