package service

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

// ListMyPipelineRuns 当前用户的全部执行流程。
func ListMyPipelineRuns(userID string) (model.PipelineRunList, error) {
	if userID == "" {
		return model.PipelineRunList{}, errors.New("请先登录")
	}
	items, err := repository.ListPipelineRunsByUser(userID)
	if err != nil {
		return model.PipelineRunList{}, err
	}
	return model.PipelineRunList{Items: items, Total: len(items)}, nil
}

// GetMyPipelineRun 当前用户单条执行流程（ownership 校验）。
func GetMyPipelineRun(userID string, id string) (model.PipelineRun, error) {
	if userID == "" {
		return model.PipelineRun{}, errors.New("请先登录")
	}
	saved, ok, err := repository.GetPipelineRunByID(id)
	if err != nil {
		return model.PipelineRun{}, err
	}
	if !ok || saved.UserID != userID {
		return model.PipelineRun{}, errors.New("执行流程不存在")
	}
	return saved, nil
}

// CreatePipelineRun 「新增执行流程」的服务端入口：根据用户选的 pipelineId + seedKey，
// 把模板当前状态 + 角色信息「快照」到 run 里。
// seedKey 非空 → status = queued，调度器会拉起来跑；
// seedKey 为空 → status = paused，等用户在列表卡片里上传原图后再保存把 seedKey 补上 + 切回 queued。
// 不在这里跑任何 step；执行靠浏览器端 RunManager 后续调 SaveMyPipelineRun PATCH 推进。
//
// 校验：pipelineId 必须是用户自己的；seedKey 非空时必须是用户自己拥有的图片。
func CreatePipelineRun(userID string, pipelineID string, seedKey string) (model.PipelineRun, error) {
	if userID == "" {
		return model.PipelineRun{}, errors.New("请先登录")
	}
	pipeline, ok, err := repository.GetPipelineByID(strings.TrimSpace(pipelineID))
	if err != nil {
		return model.PipelineRun{}, err
	}
	if !ok || pipeline.UserID != userID {
		return model.PipelineRun{}, errors.New("流水线模板不存在")
	}
	if len(pipeline.Steps) == 0 {
		return model.PipelineRun{}, errors.New("该流水线模板没有任何步骤")
	}
	seedKey = strings.TrimSpace(seedKey)
	if seedKey != "" {
		if _, err := GetImageForOwner(userID, seedKey); err != nil {
			return model.PipelineRun{}, fmt.Errorf("原图校验失败：%s", err.Error())
		}
	}

	// 拉所有 step 用到的角色一次性查出来，构造每步的快照
	agents := map[string]model.Agent{}
	for _, step := range pipeline.Steps {
		if _, has := agents[step.AgentID]; has {
			continue
		}
		agent, found, err := repository.GetAgentByID(step.AgentID)
		if err != nil {
			return model.PipelineRun{}, err
		}
		if found && agent.UserID == userID {
			agents[step.AgentID] = agent
		}
	}

	// 没传 seed 的 run 初始状态 = paused，避免调度器把它拉去跑（拿不到输入会失败）。
	// 用户在列表卡片上传 seed 后由前端把 status 改回 queued 并 PUT 上来。
	initialStatus := model.PipelineRunStatusQueued
	if seedKey == "" {
		initialStatus = model.PipelineRunStatusPaused
	}
	now := time.Now().Format(time.RFC3339)
	run := model.PipelineRun{
		ID:               newID("prun"),
		UserID:           userID,
		PipelineID:       pipeline.ID,
		PipelineNameSnap: pipeline.Name,
		SeedKey:          seedKey,
		Status:           initialStatus,
		CreatedAt:        now,
		UpdatedAt:        now,
		Steps:            make([]model.PipelineRunStep, 0, len(pipeline.Steps)),
	}
	for _, step := range pipeline.Steps {
		agent := agents[step.AgentID]
		run.Steps = append(run.Steps, model.PipelineRunStep{
			StepID:        step.StepID,
			AgentID:       step.AgentID,
			AgentNameSnap: agent.Name,
			AvatarUrlSnap: agent.AvatarURL,
			ExtraNote:     step.ExtraNote,
			Status:        model.PipelineRunStepIdle,
		})
	}
	return repository.SavePipelineRun(run)
}

// SaveMyPipelineRun 整体覆盖更新 run（前端 RunManager 推进每步状态时调用）。
// 服务端只校验 ownership + 不允许改 userId / pipelineId / createdAt；其它字段都信前端。
func SaveMyPipelineRun(userID string, item model.PipelineRun) (model.PipelineRun, error) {
	if userID == "" {
		return item, errors.New("请先登录")
	}
	saved, ok, err := repository.GetPipelineRunByID(item.ID)
	if err != nil {
		return item, err
	}
	if !ok || saved.UserID != userID {
		return item, errors.New("执行流程不存在")
	}
	item.UserID = userID
	item.PipelineID = saved.PipelineID
	item.CreatedAt = saved.CreatedAt
	item.UpdatedAt = time.Now().Format(time.RFC3339)
	// PipelineNameSnap / SeedKey 允许更新（用户在详情页可能替换 seed）
	if strings.TrimSpace(item.PipelineNameSnap) == "" {
		item.PipelineNameSnap = saved.PipelineNameSnap
	}
	if strings.TrimSpace(item.SeedKey) == "" {
		item.SeedKey = saved.SeedKey
	}
	return repository.SavePipelineRun(item)
}

// DeleteMyPipelineRun 删除当前用户的执行流程；级联清理 seed + 每步产物图片
// （如果别处没在引用，比如用户已经把产物存到素材库就保留）。
func DeleteMyPipelineRun(userID string, id string) error {
	saved, err := GetMyPipelineRun(userID, id)
	if err != nil {
		return err
	}
	if err := repository.DeletePipelineRun(saved.ID); err != nil {
		return err
	}
	keySet := map[string]bool{}
	if saved.SeedKey != "" {
		keySet[saved.SeedKey] = true
	}
	for _, step := range saved.Steps {
		if step.ManualOverrideKey != "" {
			keySet[step.ManualOverrideKey] = true
		}
		if step.OutputKey != "" {
			keySet[step.OutputKey] = true
		}
		if step.LastRunSnapshot != nil && step.LastRunSnapshot.InputKey != "" {
			keySet[step.LastRunSnapshot.InputKey] = true
		}
	}
	keys := make([]string, 0, len(keySet))
	for k := range keySet {
		keys = append(keys, k)
	}
	CleanupImagesByKeysIfOrphan(userID, keys)
	return nil
}

// StreamPipelineRunZip 把 run 里 seed + 每步产物按文件名规范打包成 zip，写到 w。
// 走 `archive/zip` 流式，不在内存里整体打包，避免大 run 撑爆。
// 文件命名：`{序号}_{角色名}_{success/failed}.{ext}`，方便用户解压后一眼看到顺序。
func StreamPipelineRunZip(userID string, id string, w io.Writer) error {
	run, err := GetMyPipelineRun(userID, id)
	if err != nil {
		return err
	}
	zw := zip.NewWriter(w)
	defer zw.Close()

	if err := addImageToZip(zw, run.SeedKey, "00_原图"); err != nil {
		// seed 缺失不致命，继续打包后面的
	}
	for index, step := range run.Steps {
		if step.OutputKey == "" {
			continue
		}
		// step 序号从 1 开始
		nameHint := fmt.Sprintf("%02d_%s", index+1, sanitizeForFilename(step.AgentNameSnap))
		if step.Status == model.PipelineRunStepFailed {
			nameHint += "_failed"
		}
		_ = addImageToZip(zw, step.OutputKey, nameHint)
	}
	return nil
}

// addImageToZip 按 storageKey 找文件 → 推到 zip writer。文件名 = `{hint}{ext}`。
// 失败不致命（只是该张图缺失），返回 error 给上层做选择性日志。
func addImageToZip(zw *zip.Writer, storageKey string, nameHint string) error {
	image, err := GetImage(storageKey)
	if err != nil {
		return err
	}
	absPath := ImageAbsPath(image)
	f, err := os.Open(absPath)
	if err != nil {
		return err
	}
	defer f.Close()
	ext := filepath.Ext(image.Path)
	if ext == "" {
		ext = extFromMime(image.MimeType)
	}
	entry, err := zw.Create(nameHint + ext)
	if err != nil {
		return err
	}
	_, err = io.Copy(entry, f)
	return err
}

// sanitizeForFilename 把角色名里的特殊字符 / 路径分隔符替换成下划线，避免 zip 内文件名异常。
func sanitizeForFilename(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "step"
	}
	return strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == ':' || r == '*' || r == '?' || r == '"' || r == '<' || r == '>' || r == '|' || r < 32 {
			return '_'
		}
		return r
	}, s)
}
