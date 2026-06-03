package service

import (
	"errors"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

// ListPublicAssets 列出公开素材库（用于前台 /asset-library 和后台素材管理）。
func ListPublicAssets(q model.Query) (model.AssetList, error) {
	q.Visibility = string(model.AssetVisibilityPublic)
	return listAssetsWithFilter(q)
}

// ListMyAssets 列出当前用户的私有素材。
func ListMyAssets(userID string, q model.Query) (model.AssetList, error) {
	q.UserID = userID
	q.Visibility = string(model.AssetVisibilityPrivate)
	return listAssetsWithFilter(q)
}

func listAssetsWithFilter(q model.Query) (model.AssetList, error) {
	items, total, err := repository.ListAssets(q)
	if err != nil {
		return model.AssetList{}, err
	}
	tags, err := repository.ListAssetTags(q)
	if err != nil {
		return model.AssetList{}, err
	}
	return model.AssetList{Items: items, Tags: tags, Total: int(total)}, nil
}

// SavePublicAsset 由管理员后台保存的公开素材。
func SavePublicAsset(item model.Asset) (model.Asset, error) {
	item.UserID = ""
	item.Visibility = model.AssetVisibilityPublic
	return saveAsset(item)
}

// SaveMyAsset 由当前用户保存的私有素材。
func SaveMyAsset(userID string, item model.Asset) (model.Asset, error) {
	if userID == "" {
		return item, errors.New("请先登录")
	}
	if item.ID != "" {
		saved, ok, err := repository.GetAssetByID(item.ID)
		if err != nil {
			return item, err
		}
		if !ok || saved.UserID != userID || saved.Visibility != model.AssetVisibilityPrivate {
			return item, errors.New("素材不存在")
		}
	}
	item.UserID = userID
	item.Visibility = model.AssetVisibilityPrivate
	return saveAsset(item)
}

// DeletePublicAsset 删除公开素材（admin 后台调用）。
// 删完后清理 cover_url / url 指向的图床图（如果别处不再引用）。
func DeletePublicAsset(id string) error {
	saved, ok, _ := repository.GetAssetByID(id)
	if err := repository.DeleteAsset(id); err != nil {
		return err
	}
	if ok {
		keySet := map[string]bool{}
		extractImageKeysFromString(saved.CoverURL, keySet)
		extractImageKeysFromString(saved.URL, keySet)
		keys := make([]string, 0, len(keySet))
		for k := range keySet {
			keys = append(keys, k)
		}
		CleanupImagesByKeysIfOrphanAdmin(keys)
	}
	return nil
}

// DeleteMyAsset 删除当前用户的私有素材；删完后清理可能被孤立的关联图片。
func DeleteMyAsset(userID string, id string) error {
	saved, ok, err := repository.GetAssetByID(id)
	if err != nil {
		return err
	}
	if !ok || saved.UserID != userID || saved.Visibility != model.AssetVisibilityPrivate {
		return errors.New("素材不存在")
	}
	if err := repository.DeleteAsset(id); err != nil {
		return err
	}
	keySet := map[string]bool{}
	extractImageKeysFromString(saved.CoverURL, keySet)
	extractImageKeysFromString(saved.URL, keySet)
	keys := make([]string, 0, len(keySet))
	for k := range keySet {
		keys = append(keys, k)
	}
	CleanupImagesByKeysIfOrphan(userID, keys)
	return nil
}

func saveAsset(item model.Asset) (model.Asset, error) {
	now := time.Now().Format(time.RFC3339)
	if item.Type == "" {
		item.Type = model.AssetTypeText
	}
	if item.ID == "" {
		item.ID = newID("asset")
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	if item.CoverURL == "" {
		item.CoverURL = assetCoverURL(item)
	}
	return repository.SaveAsset(item)
}

func assetCoverURL(item model.Asset) string {
	if item.CoverURL != "" {
		return item.CoverURL
	}
	if item.Type == model.AssetTypeImage {
		return item.URL
	}
	return ""
}
