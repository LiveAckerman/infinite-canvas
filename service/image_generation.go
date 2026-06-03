package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

// ============================================================================
// /image 生图：后端任务化驱动
//
// 以前是浏览器逐张调 /api/v1/images/* 接口、自己存盘、跑完再 upsert 记录——一刷新这次
// 生成就丢了。现在改成：点「开始生成」→ 后端建一条 running 记录 + 起后台 goroutine 把每张
// 跑完、存盘、增量写回记录；前端只管轮询这条记录。刷新 / 关页面 / 换设备都只是重新轮询，
// 任务在服务端照跑；服务重启也会在启动时把 running 记录重新挂起接着跑。
//
// 一条 generation 记录本身即任务：待跑槽数 = Count - len(Thumbnails) - len(Errors)。
// 「二次生成累加」= Count += n；「重试失败槽」= 删一条 Error；worker 自动补跑到 0 收敛终态。
//
// 注意：画布 / 角色工作台的生图仍走 handler 里的 proxy（client 驱动），不在本路径内。
// ============================================================================

const (
	imageGenUpstreamTimeout    = 5 * time.Minute
	imageGenMaxConcurrentSlots = 8  // 全局上游并发上限
	imageGenMaxCountPerCall    = 15 // 单次发起最多张数
	imageGenMaxCountTotal      = 24 // 一条记录累计产物上限（跟 generationThumbnailLimit 对齐）
	imageGenMaxRunningPerUser  = 5  // 单用户同时进行的生图任务上限
	imageGenReferenceLimit     = 9  // 图生图参考图上限，跟 handler.editsJSONReferenceLimit 一致
	imageGenUpstreamMaxAttempt = 3
	imageGenMaxStall           = 3 // worker 连续多少轮「没有任何进展」就强制收敛终态，避免死循环空转
)

var imageGenRetryBackoff = []time.Duration{2 * time.Second, 4 * time.Second}

// imageGenMu 单把粗锁，统一保护：① jobs 注册表 ② 对 generation 记录的 read-modify-write
// （槽位追加 thumbnail/error、二次生成累加、重试改 error、终态收敛）。
// 慢操作（上游请求、SaveImage 落盘、扣费）都在锁外做，锁只圈住快速的 DB 读改写，所以不卡。
var (
	imageGenMu   sync.Mutex
	imageGenJobs = map[string]bool{}
)

// 全局上游并发闸（锁外用，避免和 imageGenMu 嵌套）。
var imageGenSem = make(chan struct{}, imageGenMaxConcurrentSlots)

// StartGenerationInput 是 POST /api/generations/run 的入参。
type StartGenerationInput struct {
	ID         string   `json:"id"`   // 非空 = 追加到已有记录（二次生成累加）
	Prompt     string   `json:"prompt"`
	Mode       string   `json:"mode"` // "image" | "edit"，留空时按是否有参考图推断
	Size       string   `json:"size"`
	Quality    string   `json:"quality"`
	Count      int      `json:"count"`      // 本次要生成几张（新建=总数；追加=新增数）
	References []string `json:"references"` // 图生图参考图 storageKey
	ParentID   string   `json:"parentId"`   // 微调来源
}

// StartImageGeneration 创建 / 追加一条 running 生图记录并起后台任务，立即返回该记录。
func StartImageGeneration(userID string, in StartGenerationInput) (model.Generation, error) {
	if userID == "" {
		return model.Generation{}, errors.New("请先登录")
	}
	prompt := strings.TrimSpace(in.Prompt)
	if prompt == "" {
		return model.Generation{}, errors.New("请输入生图提示词")
	}
	count := in.Count
	if count < 1 {
		count = 1
	}
	if count > imageGenMaxCountPerCall {
		count = imageGenMaxCountPerCall
	}
	// 早校验：没有启用的模型直接报错，不建占位记录。
	if _, err := EnabledAIConfig(); err != nil {
		return model.Generation{}, err
	}
	refs := cleanImageKeys(in.References)
	if len(refs) > imageGenReferenceLimit {
		return model.Generation{}, fmt.Errorf("参考图数量超过上限（最多 %d 张）", imageGenReferenceLimit)
	}
	mode := model.GenerationModeImage
	if in.Mode == string(model.GenerationModeEdit) || len(refs) > 0 {
		mode = model.GenerationModeEdit
	}
	if mode == model.GenerationModeEdit && len(refs) == 0 {
		return model.Generation{}, errors.New("图生图需要至少一张参考图")
	}
	// 逐张校验参考图归属，避免越权引用别人的图。
	for _, key := range refs {
		if _, err := GetImageForOwner(userID, key); err != nil {
			return model.Generation{}, errors.New("参考图无权访问或不存在")
		}
	}

	if in.ID == "" {
		// 计数检查 + 建记录 + 起 worker 整段放进锁，避免并发 /run 都看到未超限而突破上限。
		imageGenMu.Lock()
		running, cntErr := repository.CountUserGenerationsByStatus(userID, string(model.GenerationStatusRunning))
		if cntErr == nil && running >= imageGenMaxRunningPerUser {
			imageGenMu.Unlock()
			return model.Generation{}, errors.New("你有较多生图任务正在进行，请等它们完成后再发起")
		}
		gen := model.Generation{
			ID:           newID("gen"),
			UserID:       userID,
			Prompt:       prompt,
			Mode:         mode,
			Size:         in.Size,
			Quality:      in.Quality,
			Count:        count,
			SuccessCount: 0,
			FailCount:    0,
			Status:       model.GenerationStatusRunning,
			Thumbnails:   []string{},
			References:   refs,
			Errors:       []string{},
			RequestParams: map[string]any{
				"mode":           string(mode),
				"size":           in.Size,
				"quality":        in.Quality,
				"n":              count,
				"referenceCount": len(refs),
				"backendJob":     true,
			},
			ParentID:  in.ParentID,
			CreatedAt: now(),
		}
		saved, err := repository.SaveGeneration(gen)
		if err != nil {
			imageGenMu.Unlock()
			return model.Generation{}, err
		}
		if !imageGenJobs[saved.ID] {
			imageGenJobs[saved.ID] = true
			go runImageGenWorker(saved.ID)
		}
		imageGenMu.Unlock()
		return saved, nil
	}

	// 追加到已有记录：Count += count，置 running，worker 自动补跑新增槽。
	imageGenMu.Lock()
	gen, ok, err := repository.GetGenerationByID(in.ID)
	if err != nil {
		imageGenMu.Unlock()
		return model.Generation{}, err
	}
	if !ok || gen.UserID != userID {
		imageGenMu.Unlock()
		return model.Generation{}, errors.New("生成记录不存在")
	}
	if gen.Count+count > imageGenMaxCountTotal {
		imageGenMu.Unlock()
		return model.Generation{}, fmt.Errorf("这条记录的产物数量已接近上限（最多 %d 张），请新建一条再生成", imageGenMaxCountTotal)
	}
	gen.Count += count
	gen.Prompt = prompt
	gen.Mode = mode
	gen.Size = in.Size
	gen.Quality = in.Quality
	gen.References = refs
	gen.Status = model.GenerationStatusRunning
	if gen.RequestParams == nil {
		gen.RequestParams = map[string]any{}
	}
	gen.RequestParams["backendJob"] = true
	saved, err := repository.SaveGeneration(gen)
	if !imageGenJobs[saved.ID] && err == nil {
		imageGenJobs[saved.ID] = true
		go runImageGenWorker(saved.ID)
	}
	imageGenMu.Unlock()
	if err != nil {
		return model.Generation{}, err
	}
	return saved, nil
}

// GetMyGeneration 取单条记录（owner 校验），前端轮询用。
func GetMyGeneration(userID string, id string) (model.Generation, error) {
	if userID == "" {
		return model.Generation{}, errors.New("请先登录")
	}
	gen, ok, err := repository.GetGenerationByID(id)
	if err != nil {
		return model.Generation{}, err
	}
	if !ok || gen.UserID != userID {
		return model.Generation{}, errors.New("生成记录不存在")
	}
	return gen, nil
}

// RetryMyGeneration 重试一条失败槽：删掉一条 Error，置 running，worker 自动补跑 1 张。
func RetryMyGeneration(userID string, id string) (model.Generation, error) {
	if userID == "" {
		return model.Generation{}, errors.New("请先登录")
	}
	imageGenMu.Lock()
	defer imageGenMu.Unlock()
	gen, ok, err := repository.GetGenerationByID(id)
	if err != nil {
		return model.Generation{}, err
	}
	if !ok || gen.UserID != userID {
		return model.Generation{}, errors.New("生成记录不存在")
	}
	// 没有失败槽时，按「再多生成 1 张」处理（Count+1），让按钮始终有意义。
	if len(gen.Errors) > 0 {
		gen.Errors = gen.Errors[:len(gen.Errors)-1]
	} else {
		if gen.Count+1 > imageGenMaxCountTotal {
			return model.Generation{}, fmt.Errorf("这条记录的产物数量已达上限（最多 %d 张）", imageGenMaxCountTotal)
		}
		gen.Count++
	}
	gen.FailCount = len(gen.Errors)
	gen.Status = model.GenerationStatusRunning
	saved, err := repository.SaveGeneration(gen)
	if err != nil {
		return model.Generation{}, err
	}
	if !imageGenJobs[saved.ID] {
		imageGenJobs[saved.ID] = true
		go runImageGenWorker(saved.ID)
	}
	return saved, nil
}

// ResumeRunningGenerations 启动时调用：把 backendJob 的 running 记录重新挂起接着跑，
// 把没有 backendJob 标记的旧（client 驱动遗留）running 记录直接收敛成终态——否则前端会一直转圈。
func ResumeRunningGenerations() {
	running, err := repository.ListRunningGenerations()
	if err != nil {
		log.Printf("resume running generations: list failed: %v", err)
		return
	}
	resumed, finalized := 0, 0
	for _, gen := range running {
		if isBackendJob(gen) {
			ensureImageGenWorker(gen.ID)
			resumed++
		} else {
			imageGenMu.Lock()
			cur, ok, _ := repository.GetGenerationByID(gen.ID)
			if ok {
				finalizeImageGenRecord(&cur, time.Time{})
				_, _ = repository.SaveGeneration(cur)
			}
			imageGenMu.Unlock()
			finalized++
		}
	}
	if resumed > 0 || finalized > 0 {
		log.Printf("resume running generations: resumed=%d finalized-stale=%d", resumed, finalized)
	}
}

// ---------------------------------------------------------------------------
// worker
// ---------------------------------------------------------------------------

func ensureImageGenWorker(genID string) {
	imageGenMu.Lock()
	defer imageGenMu.Unlock()
	if imageGenJobs[genID] {
		return
	}
	imageGenJobs[genID] = true
	go runImageGenWorker(genID)
}

// runImageGenWorker 把一条记录里待跑的槽全部跑完后收敛终态。
// 循环结构允许「跑的过程中又追加 / 重试」时本 worker 接着把新增槽也跑掉（trigger 见 worker 已注册就不再起第二个）。
func runImageGenWorker(genID string) {
	start := time.Now()
	stall := 0
	for {
		// —— 锁内：算待跑槽数 + 快照本轮要用的参数；待跑为 0（或连续多轮无进展）则收敛终态并注销，原子完成。
		imageGenMu.Lock()
		gen, ok, err := repository.GetGenerationByID(genID)
		if err != nil || !ok {
			delete(imageGenJobs, genID)
			imageGenMu.Unlock()
			return
		}
		todo := gen.Count - len(gen.Thumbnails) - len(gen.Errors)
		if todo <= 0 || stall >= imageGenMaxStall {
			finalizeImageGenRecord(&gen, start)
			_, _ = repository.SaveGeneration(gen)
			logImageGenConsume(gen)
			delete(imageGenJobs, genID)
			imageGenMu.Unlock()
			return
		}
		before := len(gen.Thumbnails) + len(gen.Errors)
		snapshot := gen
		imageGenMu.Unlock()

		// —— 锁外：取配置 / 角色；没有可用配置则把本轮 todo 全标记失败，回到循环收敛。
		cfg, cfgErr := EnabledAIConfig()
		if cfgErr != nil {
			appendImageGenErrors(genID, cfgErr.Error(), todo)
			continue
		}
		isAdmin := isUserAdmin(snapshot.UserID)

		// —— 锁外：并行跑 todo 个槽。先占全局信号量再起 goroutine，把同时存活的 slot goroutine 数
		// 也压在 imageGenMaxConcurrentSlots 以内（否则高并发下会一次性 fork 出大量阻塞 goroutine）。
		var wg sync.WaitGroup
		for i := 0; i < todo; i++ {
			imageGenSem <- struct{}{}
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer func() { <-imageGenSem }()
				runImageGenSlot(snapshot, cfg, isAdmin)
			}()
		}
		wg.Wait()

		// 无进展检测：这一轮跑完后 thumbnails+errors 没增加（极端情况，如 DB 持续异常），
		// 累计 stall，连续 imageGenMaxStall 轮后强制收敛终态，避免无 sleep 的死循环空转。
		after := before
		if cur, ok2, _ := repository.GetGenerationByID(genID); ok2 {
			after = len(cur.Thumbnails) + len(cur.Errors)
		}
		if after <= before {
			stall++
			time.Sleep(500 * time.Millisecond)
		} else {
			stall = 0
		}
	}
}

// runImageGenSlot 跑单张：余额预检 → 调上游 → 解码 → 落盘 → 记产物成功后再扣费。
// 关键：扣费放在「产物已写进记录」之后——这样 ① 写库失败不会扣了费却丢图（删掉孤儿图、不扣、下轮重试）；
// ② 服务重启恢复时，已记录的产物不会被重跑/重复扣费，只补跑没记录的槽（彻底消除「恢复重复扣费」）。
// 并发额度信号量由调用方（worker）持有，这里不再 acquire。
func runImageGenSlot(gen model.Generation, cfg model.AIConfig, isAdmin bool) {
	// 余额预检：耗尽就不再生成（非原子，最坏在余额跨 0 的瞬间放行并发数张「赠送图」，可接受且偏向用户）。
	if !isAdmin {
		if u, ok, err := repository.GetUserByID(gen.UserID); err != nil || !ok || u.Credits <= 0 {
			appendImageGenErrors(gen.ID, "额度不足，请联系管理员", 1)
			return
		}
	}
	raw, status, err := imageGenUpstream(context.Background(), cfg, gen)
	if err != nil {
		appendImageGenErrors(gen.ID, err.Error(), 1)
		return
	}
	if status < 200 || status >= 300 {
		appendImageGenErrors(gen.ID, imageGenFriendlyError(raw, status), 1)
		return
	}
	data, mime, err := extractFirstImageBytes(raw)
	if err != nil {
		appendImageGenErrors(gen.ID, err.Error(), 1)
		return
	}
	saved, err := SaveImage(gen.UserID, data, mime)
	if err != nil {
		appendImageGenErrors(gen.ID, "图片保存失败："+err.Error(), 1)
		return
	}
	// 先把产物记进记录；记录成功后才扣费。记录失败 → 删掉刚存的孤儿图、不扣费，留给下一轮重试（不会重复扣）。
	if err := appendImageGenThumbnail(gen.ID, saved.ID, imageGenRedactMeta(raw)); err != nil {
		_ = DeleteImage(gen.UserID, saved.ID)
		return
	}
	if !isAdmin {
		// 产物已记录，这里扣费失败（并发把余额扣到 0）就当这张赠送，不回滚产物。
		if _, ok, _ := ConsumeCredits(gen.UserID, 1); !ok {
			log.Printf("image gen consume after success failed (gifted) user=%s gen=%s", gen.UserID, gen.ID)
		}
	}
}

// ---------------------------------------------------------------------------
// 记录读改写（统一在 imageGenMu 下）
// ---------------------------------------------------------------------------

func appendImageGenThumbnail(genID, imageID, upstreamMeta string) error {
	imageGenMu.Lock()
	defer imageGenMu.Unlock()
	gen, ok, err := repository.GetGenerationByID(genID)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("生成记录不存在")
	}
	gen.Thumbnails = append(gen.Thumbnails, imageID)
	gen.SuccessCount = len(gen.Thumbnails)
	if upstreamMeta != "" {
		gen.UpstreamMeta = upstreamMeta
	}
	if _, err := repository.SaveGeneration(gen); err != nil {
		log.Printf("image gen append thumbnail failed gen=%s err=%v", genID, err)
		return err
	}
	return nil
}

func appendImageGenErrors(genID, msg string, n int) {
	if n <= 0 {
		return
	}
	imageGenMu.Lock()
	defer imageGenMu.Unlock()
	gen, ok, err := repository.GetGenerationByID(genID)
	if err != nil || !ok {
		return
	}
	for i := 0; i < n; i++ {
		gen.Errors = append(gen.Errors, msg)
	}
	gen.FailCount = len(gen.Errors)
	if _, err := repository.SaveGeneration(gen); err != nil {
		log.Printf("image gen append error failed gen=%s err=%v", genID, err)
	}
}

// finalizeImageGenRecord 收敛终态：成功/失败计数 + status + 耗时。调用方负责持久化（并持有 imageGenMu）。
func finalizeImageGenRecord(gen *model.Generation, start time.Time) {
	success := len(gen.Thumbnails)
	fail := gen.Count - success
	if fail < 0 {
		fail = 0
	}
	// 补齐 errors 到 fail 数量：被中断的槽 / 旧遗留 running 记录可能 errors 比应失败数少。
	// 补齐后「失败卡数量 == errors 数量 == FailCount」，前端不会出幽灵卡、重试也能正确定位（走删 error 分支）。
	for len(gen.Errors) < fail {
		gen.Errors = append(gen.Errors, "生成被中断")
	}
	gen.SuccessCount = success
	gen.FailCount = len(gen.Errors)
	switch {
	case success > 0 && fail == 0:
		gen.Status = model.GenerationStatusSuccess
	case success > 0:
		gen.Status = model.GenerationStatusPartial
	default:
		gen.Status = model.GenerationStatusFailed
	}
	if !start.IsZero() {
		gen.DurationMs = int(time.Since(start).Milliseconds())
	}
}

// logImageGenConsume 任务收敛时写一条消耗流水（按实际成功张数；admin / 0 张不写）。调用方持有 imageGenMu。
func logImageGenConsume(gen model.Generation) {
	if isUserAdmin(gen.UserID) {
		return
	}
	success := len(gen.Thumbnails)
	if success <= 0 {
		return
	}
	balance := -1
	if u, ok, err := repository.GetUserByID(gen.UserID); err == nil && ok {
		balance = u.Credits
	}
	remark := "文生图"
	if gen.Mode == model.GenerationModeEdit {
		remark = "图生图"
	}
	if err := LogCreditChange(model.CreditLog{
		UserID:  gen.UserID,
		Type:    model.CreditLogTypeConsume,
		Amount:  -success,
		Balance: balance,
		Model:   gen.Model,
		Remark:  remark,
	}); err != nil {
		log.Printf("image gen consume log failed user=%s err=%v", gen.UserID, err)
	}
}

// ---------------------------------------------------------------------------
// 上游调用（service 自带一份，避免依赖 handler 包 / 改动 proxy 路径）
// ---------------------------------------------------------------------------

func imageGenUpstream(ctx context.Context, cfg model.AIConfig, gen model.Generation) ([]byte, int, error) {
	if gen.Mode == model.GenerationModeEdit && len(gen.References) > 0 {
		return imageGenEditUpstream(ctx, cfg, gen)
	}
	return imageGenGenerateUpstream(ctx, cfg, gen)
}

func imageGenGenerateUpstream(ctx context.Context, cfg model.AIConfig, gen model.Generation) ([]byte, int, error) {
	payload := map[string]any{
		"model":           cfg.ImageModel,
		"prompt":          gen.Prompt,
		"n":               1,
		"response_format": "b64_json",
	}
	if gen.Size != "" {
		payload["size"] = gen.Size
	}
	if gen.Quality != "" {
		payload["quality"] = gen.Quality
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, err
	}
	endpoint := imageGenUpstreamURL(cfg.BaseURL, "/v1/images/generations")
	client := &http.Client{Timeout: imageGenUpstreamTimeout}
	return imageGenDoUpstream(client, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
		req.Header.Set("Content-Type", "application/json")
		return req, nil
	})
}

func imageGenEditUpstream(ctx context.Context, cfg model.AIConfig, gen model.Generation) ([]byte, int, error) {
	bodyBuf := &bytes.Buffer{}
	writer := multipart.NewWriter(bodyBuf)
	_ = writer.WriteField("prompt", gen.Prompt)
	_ = writer.WriteField("n", "1")
	if gen.Size != "" {
		_ = writer.WriteField("size", gen.Size)
	}
	if gen.Quality != "" {
		_ = writer.WriteField("quality", gen.Quality)
	}
	_ = writer.WriteField("model", cfg.ImageModel)
	_ = writer.WriteField("response_format", "b64_json")
	for _, key := range gen.References {
		image, err := GetImageForOwner(gen.UserID, key)
		if err != nil {
			return nil, 0, errors.New("参考图无权访问或不存在")
		}
		file, err := os.Open(ImageAbsPath(image))
		if err != nil {
			return nil, 0, errors.New("参考图文件丢失")
		}
		part, err := writer.CreateFormFile("image", filepath.Base(image.Path))
		if err != nil {
			_ = file.Close()
			return nil, 0, err
		}
		_, copyErr := io.Copy(part, file)
		_ = file.Close()
		if copyErr != nil {
			return nil, 0, errors.New("参考图读取失败")
		}
	}
	if err := writer.Close(); err != nil {
		return nil, 0, err
	}
	endpoint := imageGenUpstreamURL(cfg.BaseURL, "/v1/images/edits")
	payloadBytes := bodyBuf.Bytes()
	contentType := writer.FormDataContentType()
	client := &http.Client{Timeout: imageGenUpstreamTimeout}
	return imageGenDoUpstream(client, func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payloadBytes))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
		req.Header.Set("Content-Type", contentType)
		return req, nil
	})
}

// imageGenDoUpstream 对 502/503/504 + 网络瞬断重试（2s/4s 退避，最多 3 次）。
// 跟 handler 里的 doUpstreamWithRetry 同款逻辑，独立一份避免 service→handler 反向依赖。
func imageGenDoUpstream(client *http.Client, buildReq func() (*http.Request, error)) ([]byte, int, error) {
	var lastRaw []byte
	var lastStatus int
	var lastErr error
	for attempt := 0; attempt < imageGenUpstreamMaxAttempt; attempt++ {
		if attempt > 0 {
			idx := attempt - 1
			if idx >= len(imageGenRetryBackoff) {
				idx = len(imageGenRetryBackoff) - 1
			}
			time.Sleep(imageGenRetryBackoff[idx])
		}
		req, err := buildReq()
		if err != nil {
			return nil, 0, err
		}
		resp, err := client.Do(req)
		if err != nil {
			lastErr, lastRaw, lastStatus = err, nil, 0
			log.Printf("image gen upstream %s network error (attempt %d/%d): %v", req.URL.Path, attempt+1, imageGenUpstreamMaxAttempt, err)
			continue
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		lastRaw, lastStatus, lastErr = raw, resp.StatusCode, nil
		if resp.StatusCode != http.StatusBadGateway &&
			resp.StatusCode != http.StatusServiceUnavailable &&
			resp.StatusCode != http.StatusGatewayTimeout {
			return raw, resp.StatusCode, nil
		}
		log.Printf("image gen upstream %s returned %d (attempt %d/%d), retrying", req.URL.Path, resp.StatusCode, attempt+1, imageGenUpstreamMaxAttempt)
	}
	if lastErr != nil {
		return nil, 0, fmt.Errorf("上游请求失败：%s", lastErr.Error())
	}
	return lastRaw, lastStatus, nil
}

func imageGenUpstreamURL(baseURL string, path string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if strings.HasSuffix(base, "/v1") && strings.HasPrefix(path, "/v1/") {
		return base + strings.TrimPrefix(path, "/v1")
	}
	return base + path
}

// extractFirstImageBytes 从上游 b64_json 响应里取第一张图的字节。
func extractFirstImageBytes(raw []byte) ([]byte, string, error) {
	var payload struct {
		Data []struct {
			B64 string `json:"b64_json"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, "", errors.New("上游响应解析失败")
	}
	if len(payload.Data) == 0 || payload.Data[0].B64 == "" {
		return nil, "", errors.New("服务器未返回图片")
	}
	data, err := base64.StdEncoding.DecodeString(payload.Data[0].B64)
	if err != nil {
		return nil, "", errors.New("图片解码失败")
	}
	return data, "image/png", nil
}

// imageGenFriendlyError 把上游错误转成中文友好提示（避免把 HTML/原始报错透传给用户）。
func imageGenFriendlyError(raw []byte, status int) string {
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &payload); err == nil && payload.Error.Message != "" {
		return payload.Error.Message
	}
	switch status {
	case http.StatusBadGateway:
		return "服务器异常（502），请稍后重试"
	case http.StatusServiceUnavailable:
		return "服务器暂不可用（503），请稍后重试"
	case http.StatusGatewayTimeout:
		return "服务器响应超时（504），请稍后重试"
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && len(trimmed) < 300 && trimmed[0] != '<' {
		return string(trimmed)
	}
	return fmt.Sprintf("生成失败（%d）", status)
}

// imageGenRedactMeta 抹掉 b64_json 大字段后序列化回字符串，供 admin 审计；解析失败返回空。
func imageGenRedactMeta(raw []byte) string {
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return ""
	}
	if list, ok := parsed["data"].([]any); ok {
		for _, item := range list {
			if m, ok := item.(map[string]any); ok {
				if v, ok := m["b64_json"].(string); ok && v != "" {
					m["b64_json"] = fmt.Sprintf("<%d bytes redacted>", len(v))
				}
			}
		}
	}
	out, err := json.Marshal(parsed)
	if err != nil {
		return ""
	}
	return string(out)
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

func cleanImageKeys(keys []string) []string {
	out := make([]string, 0, len(keys))
	seen := map[string]bool{}
	for _, k := range keys {
		k = strings.TrimSpace(k)
		if k == "" || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, k)
	}
	return out
}

func isUserAdmin(userID string) bool {
	u, ok, err := repository.GetUserByID(userID)
	return err == nil && ok && u.Role == model.UserRoleAdmin
}

// isBackendJob 判断这条 running 记录是不是新流程（后端任务化）创建的，用于启动恢复时区分老遗留记录。
// 容忍各种 truthy 形态（bool / 数字 1 / 字符串 "true"/"1"）——RequestParams 经 JSON 往返、
// 又能被通用 SaveMyGeneration 接口写入任意客户端 JSON，硬卡 bool 会让真·后台任务被误判成遗留记录而被收敛。
func isBackendJob(gen model.Generation) bool {
	if gen.RequestParams == nil {
		return false
	}
	switch v := gen.RequestParams["backendJob"].(type) {
	case bool:
		return v
	case float64:
		return v != 0
	case int:
		return v != 0
	case string:
		return v == "true" || v == "1"
	}
	return false
}
