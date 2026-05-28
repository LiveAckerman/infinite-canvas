package service

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const (
	batchMaxItemCount   = 9
	batchMaxSourceCount = 6
	batchMaxAgentCount  = 10
	batchMaxNameLen     = 60
)

// BatchCreateItem 创建 batch 时单条主条的入参（方式 A）。
type BatchCreateItem struct {
	SeedKey    string `json:"seedKey"`
	PipelineID string `json:"pipelineId"`
	Name       string `json:"name"`
}

// BatchCreateSourceRef 方式 A 的 source ref 实际只用 itemIndex / stepIndex；
// 为了避免前端误用 runId，在专门的入参结构里只暴露这两个字段。
type BatchCreateSourceRef struct {
	ItemIndex int `json:"itemIndex"`
	StepIndex int `json:"stepIndex"`
}

// BatchCreatePostInput 方式 A 的 post 入参（用 ItemIndex，区别于 PipelineRunSourceRef 的 RunID）。
type BatchCreatePostInput struct {
	Name     string                 `json:"name"`
	Sources  []BatchCreateSourceRef `json:"sources"`
	AgentIDs []string               `json:"agentIds"`
}

// BatchCreateRequest 创建 batch 的两种入参合并体。
//   - TemplateID 非空 → 走方式 B
//   - 否则 → 走方式 A
type BatchCreateRequest struct {
	Name       string                `json:"name"`
	TemplateID string                `json:"templateId"`
	SeedKeys   []string              `json:"seedKeys"`
	Items      []BatchCreateItem     `json:"items"`
	Post       *BatchCreatePostInput `json:"post"`
}

// BatchRecheckResult /:id/recheck-post 的返回结构。
type BatchRecheckResult struct {
	Batch   model.PipelineBatchDetail `json:"batch"`
	Missing []BatchSourceMissing      `json:"missing,omitempty"`
}

// BatchSourceMissing recheck-post 时缺失的某个 source 描述。
type BatchSourceMissing struct {
	RunID     string `json:"runId"`
	StepIndex int    `json:"stepIndex"`
	Reason    string `json:"reason"`
}

// ListMyPipelineBatches 当前用户的全部批量任务（按 updated_at desc + 状态聚合计数）。
func ListMyPipelineBatches(userID string) (model.PipelineBatchList, error) {
	if userID == "" {
		return model.PipelineBatchList{}, errors.New("请先登录")
	}
	batches, err := repository.ListPipelineBatchesByUser(userID)
	if err != nil {
		return model.PipelineBatchList{}, err
	}
	items := make([]model.PipelineBatchListItem, 0, len(batches))
	for _, batch := range batches {
		runs, err := repository.ListPipelineRunsByBatch(batch.ID)
		if err != nil {
			return model.PipelineBatchList{}, err
		}
		item := model.PipelineBatchListItem{PipelineBatch: batch}
		for _, run := range runs {
			isPost := run.Kind == model.PipelineRunKindPost
			if isPost {
				item.PostTotal++
			} else {
				item.MainTotal++
			}
			switch run.Status {
			case model.PipelineRunStatusSuccess:
				if isPost {
					item.PostSuccess++
				} else {
					item.MainSuccess++
				}
			case model.PipelineRunStatusFailed, model.PipelineRunStatusPartial:
				if isPost {
					item.PostFailed++
				} else {
					item.MainFailed++
				}
			case model.PipelineRunStatusRunning:
				if isPost {
					item.PostRunning++
				} else {
					item.MainRunning++
				}
			case model.PipelineRunStatusQueued:
				if !isPost {
					item.MainQueued++
				}
			case model.PipelineRunStatusPaused:
				if !isPost {
					item.MainPaused++
				}
			}
		}
		items = append(items, item)
	}
	return model.PipelineBatchList{Items: items, Total: len(items)}, nil
}

// GetMyPipelineBatchDetail 当前用户的批量任务详情（ownership 校验）。
func GetMyPipelineBatchDetail(userID string, id string) (model.PipelineBatchDetail, error) {
	if userID == "" {
		return model.PipelineBatchDetail{}, errors.New("请先登录")
	}
	batch, ok, err := repository.GetPipelineBatchByID(id)
	if err != nil {
		return model.PipelineBatchDetail{}, err
	}
	if !ok || batch.UserID != userID {
		return model.PipelineBatchDetail{}, errors.New("批量任务不存在")
	}
	runs, err := repository.ListPipelineRunsByBatch(batch.ID)
	if err != nil {
		return model.PipelineBatchDetail{}, err
	}
	detail := model.PipelineBatchDetail{Batch: batch, MainRuns: []model.PipelineRun{}, PostRuns: []model.PipelineRun{}}
	for _, run := range runs {
		if run.Kind == model.PipelineRunKindPost {
			detail.PostRuns = append(detail.PostRuns, run)
		} else {
			detail.MainRuns = append(detail.MainRuns, run)
		}
	}
	return detail, nil
}

// CreateMyPipelineBatch 创建批量任务（两种方式）。详见 BatchCreateRequest 注释。
func CreateMyPipelineBatch(userID string, req BatchCreateRequest) (model.PipelineBatchDetail, error) {
	if userID == "" {
		return model.PipelineBatchDetail{}, errors.New("请先登录")
	}
	req.Name = strings.TrimSpace(req.Name)
	if len([]rune(req.Name)) > batchMaxNameLen {
		return model.PipelineBatchDetail{}, fmt.Errorf("批量任务名称最多 %d 个字", batchMaxNameLen)
	}
	templateID := strings.TrimSpace(req.TemplateID)
	if templateID != "" {
		return createBatchFromTemplate(userID, templateID, req.SeedKeys, req.Name)
	}
	return createBatchFreeform(userID, req.Items, req.Post, req.Name)
}

// createBatchFreeform 方式 A：直接传 items + post。
func createBatchFreeform(userID string, rawItems []BatchCreateItem, rawPost *BatchCreatePostInput, batchName string) (model.PipelineBatchDetail, error) {
	if len(rawItems) == 0 {
		return model.PipelineBatchDetail{}, errors.New("批量任务至少包含 1 条主条")
	}
	if len(rawItems) > batchMaxItemCount {
		return model.PipelineBatchDetail{}, fmt.Errorf("批量任务最多包含 %d 条主条", batchMaxItemCount)
	}
	// 预先校验每条 item 的 pipeline + seed
	prep := make([]batchPreparedItem, 0, len(rawItems))
	for index, it := range rawItems {
		pipelineID := strings.TrimSpace(it.PipelineID)
		if pipelineID == "" {
			return model.PipelineBatchDetail{}, fmt.Errorf("第 %d 条主条的流水线不能为空", index+1)
		}
		pipeline, ok, err := repository.GetPipelineByID(pipelineID)
		if err != nil {
			return model.PipelineBatchDetail{}, err
		}
		if !ok || pipeline.UserID != userID {
			return model.PipelineBatchDetail{}, fmt.Errorf("第 %d 条主条的流水线不存在", index+1)
		}
		if len(pipeline.Steps) == 0 {
			return model.PipelineBatchDetail{}, fmt.Errorf("第 %d 条主条的流水线没有任何步骤", index+1)
		}
		seedKey := strings.TrimSpace(it.SeedKey)
		if seedKey != "" {
			if _, err := GetImageForOwner(userID, seedKey); err != nil {
				return model.PipelineBatchDetail{}, fmt.Errorf("第 %d 条主条原图校验失败：%s", index+1, err.Error())
			}
		}
		prep = append(prep, batchPreparedItem{Pipeline: pipeline, SeedKey: seedKey, Name: strings.TrimSpace(it.Name)})
	}

	// 预先校验 post
	var postSources []model.PipelineRunSourceRef
	var postAgents []model.Agent
	postEnabled := false
	postName := ""
	if rawPost != nil && (len(rawPost.Sources) > 0 || len(rawPost.AgentIDs) > 0) {
		postEnabled = true
		postName = strings.TrimSpace(rawPost.Name)
		if len([]rune(postName)) > batchTemplateMaxPostNameLen {
			return model.PipelineBatchDetail{}, fmt.Errorf("后处理名称最多 %d 个字", batchTemplateMaxPostNameLen)
		}
		if len(rawPost.Sources) == 0 {
			return model.PipelineBatchDetail{}, errors.New("后处理至少需要 1 个 source")
		}
		if len(rawPost.Sources) > batchMaxSourceCount {
			return model.PipelineBatchDetail{}, fmt.Errorf("后处理最多 %d 个 source", batchMaxSourceCount)
		}
		for i, src := range rawPost.Sources {
			if src.ItemIndex < 0 || src.ItemIndex >= len(prep) {
				return model.PipelineBatchDetail{}, fmt.Errorf("后处理第 %d 个 source 的主条序号越界", i+1)
			}
			if src.StepIndex < -1 {
				return model.PipelineBatchDetail{}, fmt.Errorf("后处理第 %d 个 source 的步骤序号无效", i+1)
			}
		}
		if len(rawPost.AgentIDs) == 0 {
			return model.PipelineBatchDetail{}, errors.New("后处理至少需要 1 个角色")
		}
		if len(rawPost.AgentIDs) > batchMaxAgentCount {
			return model.PipelineBatchDetail{}, fmt.Errorf("后处理最多 %d 个角色", batchMaxAgentCount)
		}
		seen := map[string]bool{}
		postAgents = make([]model.Agent, 0, len(rawPost.AgentIDs))
		for i, agentID := range rawPost.AgentIDs {
			agentID = strings.TrimSpace(agentID)
			if agentID == "" {
				return model.PipelineBatchDetail{}, fmt.Errorf("后处理第 %d 个角色不能为空", i+1)
			}
			if seen[agentID] {
				return model.PipelineBatchDetail{}, errors.New("后处理角色不能重复")
			}
			seen[agentID] = true
			agent, ok, err := repository.GetAgentByID(agentID)
			if err != nil {
				return model.PipelineBatchDetail{}, err
			}
			if !ok || agent.UserID != userID {
				return model.PipelineBatchDetail{}, fmt.Errorf("后处理第 %d 个角色不存在", i+1)
			}
			postAgents = append(postAgents, agent)
		}
		// post sources 此时还不知道 runId（main runs 还没建），先存 stepIndex；
		// 真实 RunID 由 persistBatchAndRuns 按 sourcesItemIndexes 的映射回填。
		postSources = make([]model.PipelineRunSourceRef, len(rawPost.Sources))
		for i, src := range rawPost.Sources {
			postSources[i] = model.PipelineRunSourceRef{StepIndex: src.StepIndex}
		}
	}

	// 走持久化
	return persistBatchAndRuns(userID, batchName, prep, postEnabled, postName, postAgents, postSources, sourcesItemIndexes(rawPost))
}

// sourcesItemIndexes 把 BatchCreatePostInput 的 itemIndex 顺序提出来，便于后续把 main runs 的 ID 回填。
func sourcesItemIndexes(post *BatchCreatePostInput) []int {
	if post == nil {
		return nil
	}
	out := make([]int, len(post.Sources))
	for i, src := range post.Sources {
		out[i] = src.ItemIndex
	}
	return out
}

// createBatchFromTemplate 方式 B：从模板 + seedKeys 创建。
func createBatchFromTemplate(userID string, templateID string, seedKeys []string, batchName string) (model.PipelineBatchDetail, error) {
	template, ok, err := repository.GetPipelineBatchTemplateByID(templateID)
	if err != nil {
		return model.PipelineBatchDetail{}, err
	}
	if !ok || template.UserID != userID {
		return model.PipelineBatchDetail{}, errors.New("批处理模板不存在")
	}
	if len(seedKeys) != template.ItemCount {
		return model.PipelineBatchDetail{}, fmt.Errorf("批量任务原图数量需为 %d 张", template.ItemCount)
	}
	prep := make([]batchPreparedItem, 0, len(template.Items))
	for index, it := range template.Items {
		pipeline, ok, err := repository.GetPipelineByID(it.PipelineID)
		if err != nil {
			return model.PipelineBatchDetail{}, err
		}
		if !ok || pipeline.UserID != userID {
			return model.PipelineBatchDetail{}, fmt.Errorf("第 %d 条主条的流水线不存在", index+1)
		}
		if len(pipeline.Steps) == 0 {
			return model.PipelineBatchDetail{}, fmt.Errorf("第 %d 条主条的流水线没有任何步骤", index+1)
		}
		seedKey := strings.TrimSpace(seedKeys[index])
		if seedKey != "" {
			if _, err := GetImageForOwner(userID, seedKey); err != nil {
				return model.PipelineBatchDetail{}, fmt.Errorf("第 %d 条主条原图校验失败：%s", index+1, err.Error())
			}
		}
		prep = append(prep, batchPreparedItem{Pipeline: pipeline, SeedKey: seedKey, Name: strings.TrimSpace(it.Name)})
	}

	var postSources []model.PipelineRunSourceRef
	var postAgents []model.Agent
	postEnabled := false
	postName := ""
	var itemIndexes []int
	if template.Post != nil && (len(template.Post.Sources) > 0 || len(template.Post.AgentIDs) > 0) {
		postEnabled = true
		postName = strings.TrimSpace(template.Post.Name)
		for i, src := range template.Post.Sources {
			if src.ItemIndex < 0 || src.ItemIndex >= len(prep) {
				return model.PipelineBatchDetail{}, fmt.Errorf("模板后处理第 %d 个 source 的主条序号越界", i+1)
			}
		}
		postAgents = make([]model.Agent, 0, len(template.Post.AgentIDs))
		for i, agentID := range template.Post.AgentIDs {
			agent, ok, err := repository.GetAgentByID(agentID)
			if err != nil {
				return model.PipelineBatchDetail{}, err
			}
			if !ok || agent.UserID != userID {
				return model.PipelineBatchDetail{}, fmt.Errorf("模板后处理第 %d 个角色不存在", i+1)
			}
			postAgents = append(postAgents, agent)
		}
		postSources = make([]model.PipelineRunSourceRef, len(template.Post.Sources))
		itemIndexes = make([]int, len(template.Post.Sources))
		for i, src := range template.Post.Sources {
			postSources[i] = model.PipelineRunSourceRef{StepIndex: src.StepIndex}
			itemIndexes[i] = src.ItemIndex
		}
	}
	return persistBatchAndRuns(userID, batchName, prep, postEnabled, postName, postAgents, postSources, itemIndexes)
}

// persistBatchAndRuns 实际把 batch + main runs + post runs 写库的统一入口。
// prep 是 createBatchFreeform 内定义的 prepared 同名类型，但 Go 无法跨函数共享 unexported type；
// 为简化，直接重新定义一份匿名结构由调用方传入。这里用 interface 不优雅，所以使用一个简单的「runtime 解耦」结构。
type batchPreparedItem struct {
	Pipeline model.Pipeline
	SeedKey  string
	Name     string
}

// persistBatchAndRuns 内部统一持久化逻辑。
//   - itemIndexes：每个 postSource 对应 main runs 的 index（与 postSources 同长），写入 RunID 时按此映射。
func persistBatchAndRuns(
	userID string,
	batchName string,
	prep []batchPreparedItem,
	postEnabled bool,
	postName string,
	postAgents []model.Agent,
	postSources []model.PipelineRunSourceRef,
	itemIndexes []int,
) (model.PipelineBatchDetail, error) {
	now := time.Now().Format(time.RFC3339)
	batchID := newID("batch")
	derivedName := batchName
	if derivedName == "" {
		derivedName = fmt.Sprintf("批量任务 %s", now)
	}

	batch := model.PipelineBatch{
		ID:          batchID,
		UserID:      userID,
		Name:        derivedName,
		TotalCount:  len(prep),
		Status:      model.PipelineBatchStatusQueued,
		PostEnabled: postEnabled,
		PostName:    postName,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	mainRuns := make([]model.PipelineRun, 0, len(prep))
	for index, it := range prep {
		// 拉所有 step 用到的角色，构造每步快照（与 CreatePipelineRun 保持一致的拷贝）
		agentMap := map[string]model.Agent{}
		for _, step := range it.Pipeline.Steps {
			if _, has := agentMap[step.AgentID]; has {
				continue
			}
			agent, found, err := repository.GetAgentByID(step.AgentID)
			if err != nil {
				return model.PipelineBatchDetail{}, err
			}
			if found && agent.UserID == userID {
				agentMap[step.AgentID] = agent
			}
		}
		runName := it.Pipeline.Name
		if it.Name != "" {
			runName = it.Name
		}
		run := model.PipelineRun{
			ID:               newID("prun"),
			UserID:           userID,
			PipelineID:       it.Pipeline.ID,
			PipelineNameSnap: runName,
			SeedKey:          it.SeedKey,
			// batch 创建后统一 paused，等用户全部启动
			Status:    model.PipelineRunStatusPaused,
			BatchID:   batchID,
			Kind:      model.PipelineRunKindMain,
			Position:  index,
			CreatedAt: now,
			UpdatedAt: now,
			Steps:     make([]model.PipelineRunStep, 0, len(it.Pipeline.Steps)),
		}
		for _, step := range it.Pipeline.Steps {
			agent := agentMap[step.AgentID]
			run.Steps = append(run.Steps, model.PipelineRunStep{
				StepID:        step.StepID,
				AgentID:       step.AgentID,
				AgentNameSnap: agent.Name,
				AvatarUrlSnap: agent.AvatarURL,
				ExtraNote:     step.ExtraNote,
				Status:        model.PipelineRunStepIdle,
			})
		}
		mainRuns = append(mainRuns, run)
	}

	// 把 postSources 里的 RunID 按 itemIndexes 回填
	finalSources := make([]model.PipelineRunSourceRef, len(postSources))
	for i, src := range postSources {
		idx := 0
		if i < len(itemIndexes) {
			idx = itemIndexes[i]
		}
		if idx < 0 || idx >= len(mainRuns) {
			return model.PipelineBatchDetail{}, fmt.Errorf("后处理第 %d 个 source 的主条序号越界", i+1)
		}
		finalSources[i] = model.PipelineRunSourceRef{
			RunID:     mainRuns[idx].ID,
			StepIndex: src.StepIndex,
		}
	}

	postRuns := make([]model.PipelineRun, 0)
	if postEnabled {
		postBaseName := postName
		if postBaseName == "" {
			postBaseName = "后处理"
		}
		for k, agent := range postAgents {
			postRun := model.PipelineRun{
				ID:               newID("prun"),
				UserID:           userID,
				PipelineID:       "", // post run 不绑定具体 pipeline
				PipelineNameSnap: fmt.Sprintf("%s · %s", postBaseName, agent.Name),
				SeedKey:          "",
				Status:           model.PipelineRunStatusPaused,
				BatchID:          batchID,
				Kind:             model.PipelineRunKindPost,
				Position:         len(mainRuns) + k,
				SourceRefs:       finalSources,
				CreatedAt:        now,
				UpdatedAt:        now,
				Steps: []model.PipelineRunStep{
					{
						StepID:        newID("pstep"),
						AgentID:       agent.ID,
						AgentNameSnap: agent.Name,
						AvatarUrlSnap: agent.AvatarURL,
						ExtraNote:     "",
						Status:        model.PipelineRunStepIdle,
					},
				},
			}
			postRuns = append(postRuns, postRun)
		}
	}

	// 实际写入
	if _, err := repository.SavePipelineBatch(batch); err != nil {
		return model.PipelineBatchDetail{}, err
	}
	for _, run := range mainRuns {
		if _, err := repository.SavePipelineRun(run); err != nil {
			return model.PipelineBatchDetail{}, err
		}
	}
	for _, run := range postRuns {
		if _, err := repository.SavePipelineRun(run); err != nil {
			return model.PipelineBatchDetail{}, err
		}
	}
	return model.PipelineBatchDetail{Batch: batch, MainRuns: mainRuns, PostRuns: postRuns}, nil
}

// DeleteMyPipelineBatch 删除批量任务（级联删除所有 batch_id = id 的 runs，并尝试清理孤儿图片）。
func DeleteMyPipelineBatch(userID string, id string) error {
	if userID == "" {
		return errors.New("请先登录")
	}
	batch, ok, err := repository.GetPipelineBatchByID(id)
	if err != nil {
		return err
	}
	if !ok || batch.UserID != userID {
		return errors.New("批量任务不存在")
	}
	runs, err := repository.ListPipelineRunsByBatch(id)
	if err != nil {
		return err
	}
	if err := repository.DeletePipelineRunsByBatch(id); err != nil {
		return err
	}
	if err := repository.DeletePipelineBatch(id); err != nil {
		return err
	}
	keySet := map[string]bool{}
	for _, run := range runs {
		if run.SeedKey != "" {
			keySet[run.SeedKey] = true
		}
		for _, step := range run.Steps {
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
	}
	keys := make([]string, 0, len(keySet))
	for k := range keySet {
		keys = append(keys, k)
	}
	CleanupImagesByKeysIfOrphan(userID, keys)
	return nil
}

// DecideMyPipelineBatchPost 用户在 post_waiting 阶段做的决策。
//   - "continue"：所有 post runs 从 paused 推 queued；batch.status="running"
//   - "skip"：删所有 post runs；batch.status 按主条状态聚合最终值
func DecideMyPipelineBatchPost(userID string, id string, action model.PipelineBatchPostDecision) (model.PipelineBatchDetail, error) {
	detail, err := GetMyPipelineBatchDetail(userID, id)
	if err != nil {
		return model.PipelineBatchDetail{}, err
	}
	if detail.Batch.Status != model.PipelineBatchStatusPostWaiting {
		return model.PipelineBatchDetail{}, errors.New("批量任务当前不在等待决策状态")
	}
	now := time.Now().Format(time.RFC3339)
	switch action {
	case model.PipelineBatchDecisionContinue:
		for i, run := range detail.PostRuns {
			run.Status = model.PipelineRunStatusQueued
			run.UpdatedAt = now
			saved, err := repository.SavePipelineRun(run)
			if err != nil {
				return model.PipelineBatchDetail{}, err
			}
			detail.PostRuns[i] = saved
		}
		detail.Batch.Status = model.PipelineBatchStatusRunning
		detail.Batch.UpdatedAt = now
		savedBatch, err := repository.SavePipelineBatch(detail.Batch)
		if err != nil {
			return model.PipelineBatchDetail{}, err
		}
		detail.Batch = savedBatch
		return detail, nil
	case model.PipelineBatchDecisionSkip:
		// 收集待清理 keys（来自所有 post runs；post 自身的 SourceRefs 指向 main run 产物，
		// 由 DeleteMyPipelineBatch 那套逻辑不适用；这里 post 一般没自己的输出）
		keySet := map[string]bool{}
		for _, run := range detail.PostRuns {
			for _, step := range run.Steps {
				if step.OutputKey != "" {
					keySet[step.OutputKey] = true
				}
				if step.ManualOverrideKey != "" {
					keySet[step.ManualOverrideKey] = true
				}
				if step.LastRunSnapshot != nil && step.LastRunSnapshot.InputKey != "" {
					keySet[step.LastRunSnapshot.InputKey] = true
				}
			}
		}
		if err := repository.DeletePipelineRunsByBatchAndKind(id, model.PipelineRunKindPost); err != nil {
			return model.PipelineBatchDetail{}, err
		}
		// 按主条最终状态计算 batch 终态
		detail.Batch.Status = aggregateMainFinalStatus(detail.MainRuns)
		detail.Batch.UpdatedAt = now
		savedBatch, err := repository.SavePipelineBatch(detail.Batch)
		if err != nil {
			return model.PipelineBatchDetail{}, err
		}
		detail.Batch = savedBatch
		detail.PostRuns = []model.PipelineRun{}
		keys := make([]string, 0, len(keySet))
		for k := range keySet {
			keys = append(keys, k)
		}
		CleanupImagesByKeysIfOrphan(userID, keys)
		return detail, nil
	default:
		return model.PipelineBatchDetail{}, errors.New("不支持的决策动作")
	}
}

// RecheckMyPipelineBatchPost 重新检查 sources，可用时把 post runs 推到 queued。
func RecheckMyPipelineBatchPost(userID string, id string) (BatchRecheckResult, error) {
	detail, err := GetMyPipelineBatchDetail(userID, id)
	if err != nil {
		return BatchRecheckResult{}, err
	}
	if detail.Batch.Status != model.PipelineBatchStatusPostWaiting {
		return BatchRecheckResult{}, errors.New("批量任务当前不在等待决策状态")
	}
	if len(detail.PostRuns) == 0 {
		return BatchRecheckResult{}, errors.New("批量任务没有后处理")
	}
	// 所有 post runs 共享同一份 sources，取第 0 个即可
	missing := CheckSourcesAvailable(detail.MainRuns, detail.PostRuns[0].SourceRefs)
	if len(missing) > 0 {
		return BatchRecheckResult{Batch: detail, Missing: missing}, nil
	}
	now := time.Now().Format(time.RFC3339)
	for i, run := range detail.PostRuns {
		run.Status = model.PipelineRunStatusQueued
		run.UpdatedAt = now
		saved, err := repository.SavePipelineRun(run)
		if err != nil {
			return BatchRecheckResult{}, err
		}
		detail.PostRuns[i] = saved
	}
	detail.Batch.Status = model.PipelineBatchStatusRunning
	detail.Batch.UpdatedAt = now
	savedBatch, err := repository.SavePipelineBatch(detail.Batch)
	if err != nil {
		return BatchRecheckResult{}, err
	}
	detail.Batch = savedBatch
	return BatchRecheckResult{Batch: detail}, nil
}

// CheckSourcesAvailable 逐个检查 sourceRefs 是否在 mainRuns 里指向有效产物。
//   - stepIndex == -1：检查 run.SeedKey 非空
//   - stepIndex >= 0：检查 run.Steps[stepIndex].OutputKey 非空且 Status == "success"
func CheckSourcesAvailable(mainRuns []model.PipelineRun, sources []model.PipelineRunSourceRef) []BatchSourceMissing {
	runMap := map[string]model.PipelineRun{}
	for _, r := range mainRuns {
		runMap[r.ID] = r
	}
	missing := make([]BatchSourceMissing, 0)
	for _, src := range sources {
		run, ok := runMap[src.RunID]
		if !ok {
			missing = append(missing, BatchSourceMissing{RunID: src.RunID, StepIndex: src.StepIndex, Reason: "对应主条不存在"})
			continue
		}
		if src.StepIndex == -1 {
			if strings.TrimSpace(run.SeedKey) == "" {
				missing = append(missing, BatchSourceMissing{RunID: src.RunID, StepIndex: src.StepIndex, Reason: "该主条 seed 未上传"})
			}
			continue
		}
		if src.StepIndex < 0 || src.StepIndex >= len(run.Steps) {
			missing = append(missing, BatchSourceMissing{RunID: src.RunID, StepIndex: src.StepIndex, Reason: "该主条步骤序号越界"})
			continue
		}
		step := run.Steps[src.StepIndex]
		if step.OutputKey == "" {
			missing = append(missing, BatchSourceMissing{RunID: src.RunID, StepIndex: src.StepIndex, Reason: fmt.Sprintf("该主条第 %d 步还没跑", src.StepIndex+1)})
			continue
		}
		if step.Status != model.PipelineRunStepSuccess {
			missing = append(missing, BatchSourceMissing{RunID: src.RunID, StepIndex: src.StepIndex, Reason: fmt.Sprintf("该主条第 %d 步失败", src.StepIndex+1)})
			continue
		}
	}
	return missing
}

// UpdateBatchStatusAfterRunChange 在 SaveMyPipelineRun 尾部调用。
// 根据当前 batch 内所有 runs 的状态推进 batch.status，并在主条全部完成时
// 自动检查 sources / 推 post runs。
func UpdateBatchStatusAfterRunChange(batchID string) error {
	batch, ok, err := repository.GetPipelineBatchByID(batchID)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	runs, err := repository.ListPipelineRunsByBatch(batchID)
	if err != nil {
		return err
	}
	mainRuns := make([]model.PipelineRun, 0)
	postRuns := make([]model.PipelineRun, 0)
	for _, r := range runs {
		if r.Kind == model.PipelineRunKindPost {
			postRuns = append(postRuns, r)
		} else {
			mainRuns = append(mainRuns, r)
		}
	}

	mainAllDone := len(mainRuns) > 0
	mainHasActive := false
	for _, r := range mainRuns {
		if !isTerminalRunStatus(r.Status) {
			mainAllDone = false
		}
		if r.Status == model.PipelineRunStatusRunning || r.Status == model.PipelineRunStatusQueued {
			mainHasActive = true
		}
	}
	postAllDone := true
	postHasActive := false
	for _, r := range postRuns {
		if !isTerminalRunStatus(r.Status) {
			postAllDone = false
		}
		if r.Status == model.PipelineRunStatusRunning || r.Status == model.PipelineRunStatusQueued {
			postHasActive = true
		}
	}

	newStatus := batch.Status

	switch {
	case mainHasActive || postHasActive:
		newStatus = model.PipelineBatchStatusRunning
	case mainAllDone && batch.PostEnabled && len(postRuns) > 0 && !postAllDone:
		// 主条都 done，但 post 还没启动 → 检查 sources
		// （此分支只在 post 全 paused 时进入；postHasActive=false 但 postAllDone=false 意味着至少一条 paused）
		allPostPaused := true
		for _, r := range postRuns {
			if r.Status != model.PipelineRunStatusPaused {
				allPostPaused = false
				break
			}
		}
		if allPostPaused {
			missing := CheckSourcesAvailable(mainRuns, postRuns[0].SourceRefs)
			if len(missing) == 0 {
				// 全 OK → 把所有 post runs 推到 queued + batch=running
				now := time.Now().Format(time.RFC3339)
				for i, r := range postRuns {
					r.Status = model.PipelineRunStatusQueued
					r.UpdatedAt = now
					if saved, err := repository.SavePipelineRun(r); err == nil {
						postRuns[i] = saved
					}
				}
				newStatus = model.PipelineBatchStatusRunning
			} else {
				newStatus = model.PipelineBatchStatusPostWaiting
			}
		} else {
			// 不是全 paused（已被手动推进过），按聚合逻辑走
			newStatus = aggregateFinalStatus(mainRuns, postRuns)
		}
	case mainAllDone && (!batch.PostEnabled || len(postRuns) == 0):
		newStatus = aggregateMainFinalStatus(mainRuns)
	case mainAllDone && postAllDone:
		newStatus = aggregateFinalStatus(mainRuns, postRuns)
	}

	if newStatus == batch.Status {
		return nil
	}
	batch.Status = newStatus
	batch.UpdatedAt = time.Now().Format(time.RFC3339)
	_, err = repository.SavePipelineBatch(batch)
	return err
}

func isTerminalRunStatus(s model.PipelineRunStatus) bool {
	switch s {
	case model.PipelineRunStatusSuccess, model.PipelineRunStatusPartial, model.PipelineRunStatusFailed:
		return true
	}
	return false
}

// aggregateMainFinalStatus 主条聚合最终状态：全 success → success；全 failed → failed；混合 → partial。
func aggregateMainFinalStatus(mainRuns []model.PipelineRun) model.PipelineBatchStatus {
	if len(mainRuns) == 0 {
		return model.PipelineBatchStatusFailed
	}
	successCount := 0
	failedCount := 0
	for _, r := range mainRuns {
		switch r.Status {
		case model.PipelineRunStatusSuccess:
			successCount++
		case model.PipelineRunStatusFailed, model.PipelineRunStatusPartial:
			failedCount++
		}
	}
	if successCount == len(mainRuns) {
		return model.PipelineBatchStatusSuccess
	}
	if failedCount == len(mainRuns) {
		return model.PipelineBatchStatusFailed
	}
	return model.PipelineBatchStatusPartial
}

// aggregateFinalStatus 主条 + post 全跑完后的最终状态。
func aggregateFinalStatus(mainRuns []model.PipelineRun, postRuns []model.PipelineRun) model.PipelineBatchStatus {
	all := make([]model.PipelineRun, 0, len(mainRuns)+len(postRuns))
	all = append(all, mainRuns...)
	all = append(all, postRuns...)
	if len(all) == 0 {
		return model.PipelineBatchStatusFailed
	}
	successCount := 0
	failedCount := 0
	for _, r := range all {
		switch r.Status {
		case model.PipelineRunStatusSuccess:
			successCount++
		case model.PipelineRunStatusFailed, model.PipelineRunStatusPartial:
			failedCount++
		}
	}
	if successCount == len(all) {
		return model.PipelineBatchStatusSuccess
	}
	if failedCount == len(all) {
		return model.PipelineBatchStatusFailed
	}
	return model.PipelineBatchStatusPartial
}

// StreamPipelineBatchZip 把整个 batch 打包成 zip 流式写到 w。
// 结构：
//
//	{sanitize(batchName)}_{yyMMdd}.zip
//	├── 01_main_{runName}/
//	│   ├── 00_seed.{ext}
//	│   ├── 01_{agentName}.{ext}
//	│   └── ...
//	└── post_{postName}/  （如启用）
//	    ├── sources/
//	    │   ├── from-run01-step2.{ext}
//	    │   └── ...
//	    └── 01_{agent1Name}.{ext}, 02_{agent2Name}.{ext}, ...
func StreamPipelineBatchZip(userID string, id string, w io.Writer) error {
	detail, err := GetMyPipelineBatchDetail(userID, id)
	if err != nil {
		return err
	}
	if detail.Batch.Status != model.PipelineBatchStatusSuccess &&
		detail.Batch.Status != model.PipelineBatchStatusPartial &&
		detail.Batch.Status != model.PipelineBatchStatusFailed {
		return errors.New("批量任务尚未完成，无法下载")
	}

	zw := zip.NewWriter(w)
	defer zw.Close()

	// 主条：按 position asc
	// position 已是 0..N-1
	for _, run := range detail.MainRuns {
		runName := sanitizeForFilename(run.PipelineNameSnap)
		prefix := fmt.Sprintf("%02d_main_%s", run.Position+1, runName)
		if run.SeedKey != "" {
			_ = addImageToZip(zw, run.SeedKey, prefix+"/00_seed")
		}
		for stepIndex, step := range run.Steps {
			if step.OutputKey == "" {
				continue
			}
			nameHint := fmt.Sprintf("%s/%02d_%s", prefix, stepIndex+1, sanitizeForFilename(step.AgentNameSnap))
			if step.Status == model.PipelineRunStepFailed {
				nameHint += "_failed"
			}
			_ = addImageToZip(zw, step.OutputKey, nameHint)
		}
	}

	if detail.Batch.PostEnabled && len(detail.PostRuns) > 0 {
		postName := sanitizeForFilename(detail.Batch.PostName)
		if postName == "" {
			postName = "post"
		}
		postPrefix := fmt.Sprintf("post_%s", postName)
		// sources：从第一个 post run 取（所有 post runs 共享同一份 sources）
		runMap := map[string]model.PipelineRun{}
		for _, r := range detail.MainRuns {
			runMap[r.ID] = r
		}
		for srcIndex, src := range detail.PostRuns[0].SourceRefs {
			sourceRun, ok := runMap[src.RunID]
			if !ok {
				continue
			}
			var key string
			var label string
			runOrder := sourceRun.Position + 1
			if src.StepIndex == -1 {
				key = sourceRun.SeedKey
				label = fmt.Sprintf("%02d_from-run%02d-seed", srcIndex+1, runOrder)
			} else if src.StepIndex >= 0 && src.StepIndex < len(sourceRun.Steps) {
				key = sourceRun.Steps[src.StepIndex].OutputKey
				label = fmt.Sprintf("%02d_from-run%02d-step%02d", srcIndex+1, runOrder, src.StepIndex+1)
			}
			if key == "" {
				continue
			}
			_ = addImageToZip(zw, key, fmt.Sprintf("%s/sources/%s", postPrefix, label))
		}
		// 各 post run 的产物平铺
		for postIndex, run := range detail.PostRuns {
			for _, step := range run.Steps {
				if step.OutputKey == "" {
					continue
				}
				nameHint := fmt.Sprintf("%s/%02d_%s", postPrefix, postIndex+1, sanitizeForFilename(step.AgentNameSnap))
				if step.Status == model.PipelineRunStepFailed {
					nameHint += "_failed"
				}
				_ = addImageToZip(zw, step.OutputKey, nameHint)
			}
		}
	}
	return nil
}

// BatchZipFilename 给前端拼一个友好的文件名（如 「My批次_260528.zip」）。
func BatchZipFilename(batch model.PipelineBatch) string {
	name := sanitizeForFilename(batch.Name)
	if name == "" {
		name = "batch"
	}
	stamp := time.Now().Format("060102")
	return fmt.Sprintf("%s_%s.zip", name, stamp)
}
