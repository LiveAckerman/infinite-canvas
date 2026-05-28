package service

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func ListCanvases(userID string, q model.Query) (model.CanvasList, error) {
	items, total, err := repository.ListCanvases(userID, q)
	if err != nil {
		return model.CanvasList{}, err
	}
	return model.CanvasList{Items: items, Total: int(total)}, nil
}

func GetCanvas(userID string, id string) (model.Canvas, error) {
	item, ok, err := repository.GetCanvas(userID, id)
	if err != nil {
		return model.Canvas{}, err
	}
	if !ok {
		return model.Canvas{}, errors.New("画布不存在")
	}
	return item, nil
}

func SaveCanvas(userID string, item model.Canvas) (model.Canvas, error) {
	if userID == "" {
		return item, errors.New("请先登录")
	}
	if item.ID == "" {
		item.ID = newID("canvas")
		item.CreatedAt = now()
	} else if saved, ok, err := repository.GetCanvas(userID, item.ID); err != nil {
		return item, err
	} else if ok {
		item.CreatedAt = saved.CreatedAt
	} else {
		item.CreatedAt = now()
	}
	item.UserID = userID
	item.UpdatedAt = now()
	return repository.SaveCanvas(item)
}

func DeleteCanvas(userID string, id string) error {
	// 删前先把 canvas.data 里所有 storageKey 攒出来；canvas 是自由 JSON 结构，
	// 用 walkJSONForImageKeys 递归扫整棵树。
	saved, _, _ := repository.GetCanvas(userID, id)
	if err := repository.DeleteCanvas(userID, id); err != nil {
		return err
	}
	keySet := map[string]bool{}
	extractImageKeysFromString(saved.CoverURL, keySet)
	walkJSONForImageKeys(saved.Data, keySet)
	keys := make([]string, 0, len(keySet))
	for k := range keySet {
		keys = append(keys, k)
	}
	CleanupImagesByKeysIfOrphan(userID, keys)
	return nil
}
