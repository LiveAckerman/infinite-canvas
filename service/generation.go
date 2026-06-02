package service

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

// 一条生成记录最多保留多少张产物缩略图。后端任务化生图单次最多 ~10 张、再叠加「二次生成累加」，
// 取一个宽松上限，避免 service.SaveGeneration 把多张产物截断丢失（删除产物时也走这里）。
const generationThumbnailLimit = 24

func ListGenerations(userID string, q model.Query) (model.GenerationList, error) {
	items, total, err := repository.ListGenerations(userID, q)
	if err != nil {
		return model.GenerationList{}, err
	}
	return model.GenerationList{Items: items, Total: int(total)}, nil
}

func SaveGeneration(userID string, item model.Generation) (model.Generation, error) {
	if userID == "" {
		return item, errors.New("请先登录")
	}
	// 更新时若 thumbnails / references 里某些 key 被移除（例如用户删了某张生成结果），
	// 攒起来等保存成功后做孤儿清理。正常生成流程 thumbnails 只增不减，removedKeys 为空、不触发扫表。
	var removedKeys []string
	if item.ID == "" {
		item.ID = newID("gen")
		item.CreatedAt = now()
	} else {
		saved, ok, err := repository.GetGenerationByID(item.ID)
		if err != nil {
			return item, err
		}
		if !ok {
			// 不允许客户端任意指定一个新 id 创建——只能更新已有记录
			return item, errors.New("生成记录不存在")
		}
		if saved.UserID != userID {
			return item, errors.New("权限不足")
		}
		// 保留原 created_at，避免被 client 覆盖
		item.CreatedAt = saved.CreatedAt
		removedKeys = removedImageKeys(saved.Thumbnails, item.Thumbnails)
		removedKeys = append(removedKeys, removedImageKeys(saved.References, item.References)...)
	}
	item.UserID = userID
	if len(item.Thumbnails) > generationThumbnailLimit {
		item.Thumbnails = item.Thumbnails[:generationThumbnailLimit]
	}
	if item.Status == "" {
		item.Status = model.GenerationStatusSuccess
	}
	if item.Count < 0 {
		item.Count = 0
	}
	out, err := repository.SaveGeneration(item)
	if err != nil {
		return out, err
	}
	if len(removedKeys) > 0 {
		CleanupImagesByKeysIfOrphan(userID, removedKeys)
	}
	return out, nil
}

// removedImageKeys 返回 oldKeys 里有、newKeys 里没有的 key（用于保存后清理被移除的孤儿图）。
func removedImageKeys(oldKeys, newKeys []string) []string {
	if len(oldKeys) == 0 {
		return nil
	}
	keep := make(map[string]bool, len(newKeys))
	for _, k := range newKeys {
		keep[k] = true
	}
	var removed []string
	for _, k := range oldKeys {
		if k != "" && !keep[k] {
			removed = append(removed, k)
		}
	}
	return removed
}

func DeleteGeneration(userID string, id string) error {
	// 删除前先把这条 generation 引用的所有 storageKey 攒出来，
	// 删完再调 CleanupImagesByKeysIfOrphan 一次性清理已无引用的图片。
	saved, ok, _ := repository.GetGenerationByID(id)
	if err := repository.DeleteGeneration(userID, id); err != nil {
		return err
	}
	if ok && saved.UserID == userID {
		keys := append([]string{}, saved.Thumbnails...)
		keys = append(keys, saved.References...)
		CleanupImagesByKeysIfOrphan(userID, keys)
	}
	return nil
}

// ListAllGenerationsForAdmin 管理后台用，给每条记录附上 username。
func ListAllGenerationsForAdmin(q model.Query) (model.AdminGenerationList, error) {
	items, total, err := repository.ListAllGenerations(q)
	if err != nil {
		return model.AdminGenerationList{}, err
	}
	userIDs := uniqueUserIDs(items, func(g model.Generation) string { return g.UserID })
	users, err := repository.GetUsersByIDs(userIDs)
	if err != nil {
		return model.AdminGenerationList{}, err
	}
	out := make([]model.AdminGenerationItem, 0, len(items))
	for _, item := range items {
		out = append(out, model.AdminGenerationItem{
			Generation: item,
			Username:   users[item.UserID].Username,
		})
	}
	return model.AdminGenerationList{Items: out, Total: int(total)}, nil
}

func uniqueUserIDs[T any](items []T, pick func(T) string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0)
	for _, item := range items {
		id := pick(item)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}
