package service

import (
	"fmt"
	"log"
	"regexp"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

// imageURLPattern 匹配 /api/images/{img-xxx} 形式，从 cover_url / avatar_url 这类
// 含 URL 的字符串字段里抽出图床 storageKey。
var imageURLPattern = regexp.MustCompile(`/api/images/(img-[A-Za-z0-9_-]+)`)

// extractImageKeysFromString 把字符串里所有 storageKey 抽到 set 里：
//   - "img-xxx" 直接当 storageKey
//   - "/api/images/img-xxx" 形式提取
func extractImageKeysFromString(s string, set map[string]bool) {
	if s == "" {
		return
	}
	if strings.HasPrefix(s, "img-") {
		set[s] = true
		return
	}
	for _, match := range imageURLPattern.FindAllStringSubmatch(s, -1) {
		if len(match) >= 2 {
			set[match[1]] = true
		}
	}
}

// walkJSONForImageKeys 递归扫一棵 JSON 树，把所有 storageKey 字段值 + 像 /api/images/xxx
// 这种字符串都抽到 set。canvas.data 这种自由结构走它即可。
func walkJSONForImageKeys(value any, set map[string]bool) {
	switch v := value.(type) {
	case string:
		extractImageKeysFromString(v, set)
	case []any:
		for _, item := range v {
			walkJSONForImageKeys(item, set)
		}
	case map[string]any:
		for k, item := range v {
			// 显式的 storageKey 字段（画布节点 metadata 里用）
			if k == "storageKey" {
				if s, ok := item.(string); ok && s != "" {
					set[s] = true
					continue
				}
			}
			walkJSONForImageKeys(item, set)
		}
	}
}

// CollectInUseImageKeys 扫描所有引用图片的表，返回 in-use 的 storageKey 集合。
// 是孤儿清理和级联删除共用的核心。一次完整扫描，对 ~1000 行规模的表 sub-second。
//
// 扫描的引用源：
//   - generations.thumbnails / references
//   - canvases.cover_url / data（递归 JSON 树）
//   - assets.cover_url / url
//   - prompts.cover_url
//   - agents.avatar_url / reference_image_keys
//   - agent_workstation_cards.reference_keys / output_key
//   - pipeline_runs.seed_key / steps[].output_key / manual_override_key / last_run_snapshot.input_key
func CollectInUseImageKeys() (map[string]bool, error) {
	db, err := repository.DB()
	if err != nil {
		return nil, err
	}
	inUse := make(map[string]bool, 256)

	// generations（"references" 是 SQL 保留字，直接 Find 让 GORM 自动 quote 列名）
	var gens []model.Generation
	if err := db.Find(&gens).Error; err != nil {
		return nil, err
	}
	for _, g := range gens {
		for _, key := range g.Thumbnails {
			if key != "" {
				inUse[key] = true
			}
		}
		for _, key := range g.References {
			if key != "" {
				inUse[key] = true
			}
		}
	}

	// canvases（含完整 data JSON）
	var canvases []model.Canvas
	if err := db.Find(&canvases).Error; err != nil {
		return nil, err
	}
	for _, c := range canvases {
		extractImageKeysFromString(c.CoverURL, inUse)
		walkJSONForImageKeys(c.Data, inUse)
	}

	// assets
	var assets []model.Asset
	if err := db.Find(&assets).Error; err != nil {
		return nil, err
	}
	for _, a := range assets {
		extractImageKeysFromString(a.CoverURL, inUse)
		extractImageKeysFromString(a.URL, inUse)
	}

	// prompts
	var prompts []model.Prompt
	if err := db.Find(&prompts).Error; err != nil {
		return nil, err
	}
	for _, p := range prompts {
		extractImageKeysFromString(p.CoverURL, inUse)
	}

	// agents
	var agents []model.Agent
	if err := db.Find(&agents).Error; err != nil {
		return nil, err
	}
	for _, a := range agents {
		extractImageKeysFromString(a.AvatarURL, inUse)
		for _, key := range a.ReferenceImageKeys {
			if key != "" {
				inUse[key] = true
			}
		}
	}

	// agent_workstation_cards
	var cards []model.AgentWorkstationCard
	if err := db.Find(&cards).Error; err != nil {
		return nil, err
	}
	for _, c := range cards {
		for _, k := range c.ReferenceKeys {
			if k != "" {
				inUse[k] = true
			}
		}
		if c.OutputKey != "" {
			inUse[c.OutputKey] = true
		}
	}

	// pipeline_runs
	var runs []model.PipelineRun
	if err := db.Find(&runs).Error; err != nil {
		return nil, err
	}
	for _, r := range runs {
		if r.SeedKey != "" {
			inUse[r.SeedKey] = true
		}
		for _, step := range r.Steps {
			if step.ManualOverrideKey != "" {
				inUse[step.ManualOverrideKey] = true
			}
			if step.OutputKey != "" {
				inUse[step.OutputKey] = true
			}
			if step.LastRunSnapshot != nil && step.LastRunSnapshot.InputKey != "" {
				inUse[step.LastRunSnapshot.InputKey] = true
			}
		}
	}

	return inUse, nil
}

// OrphanImageStats 孤儿图片统计结果，供 admin UI 展示。
type OrphanImageStats struct {
	Items        []OrphanImageItem  `json:"items"`
	TotalCount   int                `json:"totalCount"`
	TotalBytes   int64              `json:"totalBytes"`
	UsageByUser  []ImageUsageByUser `json:"usageByUser"`
	GrandImages  int                `json:"grandImages"`  // 全库图片总数
	GrandBytes   int64              `json:"grandBytes"`   // 全库图片总占用
	OrphanShare  float64            `json:"orphanShare"`  // 孤儿占总占用比例
}

// OrphanImageItem 单条孤儿信息。
type OrphanImageItem struct {
	ID        string `json:"id"`
	UserID    string `json:"userId"`
	Username  string `json:"username,omitempty"`
	MimeType  string `json:"mimeType"`
	Size      int    `json:"size"`
	CreatedAt string `json:"createdAt"`
}

// ImageUsageByUser 每个用户的图片总数/总占用，admin 看哪个用户存得多。
type ImageUsageByUser struct {
	UserID     string `json:"userId"`
	Username   string `json:"username,omitempty"`
	ImageCount int    `json:"imageCount"`
	TotalBytes int64  `json:"totalBytes"`
}

// FindOrphanImages 扫描出所有不被任何业务对象引用的 image 行。
// 顺便把全库的「按用户聚合统计」也算了，admin UI 一并展示。
func FindOrphanImages() (OrphanImageStats, error) {
	inUse, err := CollectInUseImageKeys()
	if err != nil {
		return OrphanImageStats{}, err
	}
	db, err := repository.DB()
	if err != nil {
		return OrphanImageStats{}, err
	}
	var images []model.Image
	if err := db.Find(&images).Error; err != nil {
		return OrphanImageStats{}, err
	}

	stats := OrphanImageStats{
		Items: make([]OrphanImageItem, 0),
	}
	usage := map[string]*ImageUsageByUser{}
	userIDSet := map[string]bool{}
	for _, img := range images {
		stats.GrandImages++
		stats.GrandBytes += int64(img.Size)
		if u, ok := usage[img.UserID]; ok {
			u.ImageCount++
			u.TotalBytes += int64(img.Size)
		} else {
			usage[img.UserID] = &ImageUsageByUser{UserID: img.UserID, ImageCount: 1, TotalBytes: int64(img.Size)}
		}
		if inUse[img.ID] {
			continue
		}
		stats.Items = append(stats.Items, OrphanImageItem{
			ID:        img.ID,
			UserID:    img.UserID,
			MimeType:  img.MimeType,
			Size:      img.Size,
			CreatedAt: img.CreatedAt,
		})
		userIDSet[img.UserID] = true
		stats.TotalCount++
		stats.TotalBytes += int64(img.Size)
	}
	if stats.GrandBytes > 0 {
		stats.OrphanShare = float64(stats.TotalBytes) / float64(stats.GrandBytes)
	}

	// 把 username 一次性 join 进去，admin 不用再请求一遍。
	allUserIDs := make([]string, 0, len(usage))
	for uid := range usage {
		allUserIDs = append(allUserIDs, uid)
	}
	users, err := repository.GetUsersByIDs(allUserIDs)
	if err != nil {
		users = map[string]model.User{}
	}
	for i := range stats.Items {
		if u, ok := users[stats.Items[i].UserID]; ok {
			stats.Items[i].Username = u.Username
		}
	}
	stats.UsageByUser = make([]ImageUsageByUser, 0, len(usage))
	for _, u := range usage {
		if user, ok := users[u.UserID]; ok {
			u.Username = user.Username
		}
		stats.UsageByUser = append(stats.UsageByUser, *u)
	}

	return stats, nil
}

// CleanupOrphanImages 执行实际清理：对每条孤儿调用 DeleteImageInternal
// （走 owner-bypass 路径，因为 admin 才能调）。返回清掉的条数与释放字节数。
func CleanupOrphanImages() (count int, freedBytes int64, err error) {
	stats, err := FindOrphanImages()
	if err != nil {
		return 0, 0, err
	}
	for _, item := range stats.Items {
		image, ok, errGet := repository.GetImageByID(item.ID)
		if errGet != nil || !ok {
			continue
		}
		if err := deleteImageInternal(image); err != nil {
			log.Printf("cleanup orphan image %s failed: %v", item.ID, err)
			continue
		}
		count++
		freedBytes += int64(item.Size)
	}
	return count, freedBytes, nil
}

// CleanupImagesByKeysIfOrphanAdmin 跟 CleanupImagesByKeysIfOrphan 一样的扫描 +
// orphan 判定逻辑，但**不**做 owner 校验。给 admin 删公开素材 / 删提示词 / 删用户
// 这类「该资源没有明确 user 归属」或「跨用户操作」的路径用。
//
// 仍然走 in-use 扫描，被任何业务表引用的图就保留；只有真孤儿才会被物理删除。
func CleanupImagesByKeysIfOrphanAdmin(keys []string) {
	if len(keys) == 0 {
		return
	}
	uniq := map[string]bool{}
	pending := make([]string, 0, len(keys))
	for _, k := range keys {
		k = strings.TrimSpace(k)
		if k == "" || uniq[k] {
			continue
		}
		uniq[k] = true
		pending = append(pending, k)
	}
	if len(pending) == 0 {
		return
	}
	inUse, err := CollectInUseImageKeys()
	if err != nil {
		log.Printf("cleanup keys (admin): collect in-use failed: %v", err)
		return
	}
	for _, key := range pending {
		if inUse[key] {
			continue
		}
		image, ok, err := repository.GetImageByID(key)
		if err != nil || !ok {
			continue
		}
		if err := deleteImageInternal(image); err != nil {
			log.Printf("cleanup image %s (admin) failed: %v", key, err)
		}
	}
}

// CleanupImagesByKeysIfOrphan 给定一批可能成为孤儿的 storageKey（通常是某条业务记录
// 刚被删除时它引用过的图），扫一遍 in-use 集合，对其中**已不在**引用里的执行删除。
// 通过 owner 校验（只删属于该用户的图），多了一层防御。
//
// 一次调用 = 一次 CollectInUseImageKeys 扫描，所以调用者应该把删除一条记录里
// 涉及的所有 key 攒到一个数组里一次性传进来，避免 N 次扫表。
func CleanupImagesByKeysIfOrphan(userID string, keys []string) {
	if len(keys) == 0 {
		return
	}
	// 去重避免重复 GetImageByID
	uniq := map[string]bool{}
	pending := make([]string, 0, len(keys))
	for _, k := range keys {
		k = strings.TrimSpace(k)
		if k == "" || uniq[k] {
			continue
		}
		uniq[k] = true
		pending = append(pending, k)
	}
	if len(pending) == 0 {
		return
	}
	inUse, err := CollectInUseImageKeys()
	if err != nil {
		log.Printf("cleanup keys: collect in-use failed: %v", err)
		return
	}
	for _, key := range pending {
		if inUse[key] {
			continue
		}
		image, ok, err := repository.GetImageByID(key)
		if err != nil || !ok {
			continue
		}
		if image.UserID != userID {
			// owner 不匹配 → 不动；可能是别人引用但漏掉了某种数据源
			continue
		}
		if err := deleteImageInternal(image); err != nil {
			log.Printf("cleanup image %s failed: %v", key, err)
		}
	}
}

// UserImageQuotaBytes 单用户图片总占用上限，超出 SaveImage 时拒绝。
// 普通用户 2GB，admin 不受限（在 SaveImage 里识别）。
// 磁盘 58G / 余 20G+，2GB/人 对当前用户量足够宽松；真不够再调这一个常量即可。
const UserImageQuotaBytes int64 = 2 * 1024 * 1024 * 1024

// 错误文案跟着常量走，改上限不用再手改字符串（避免「常量改了文案还写 500MB」的不一致）。
var errImageQuotaExceeded = fmt.Errorf("您的图片存储已达上限（%dGB），请清理一些图片后再上传", UserImageQuotaBytes/(1024*1024*1024))

// userImageTotalBytes 返回单个用户当前已用图片总字节数。
func userImageTotalBytes(userID string) (int64, error) {
	db, err := repository.DB()
	if err != nil {
		return 0, err
	}
	var total int64
	if err := db.Model(&model.Image{}).Where("user_id = ?", userID).Select("COALESCE(SUM(size),0)").Scan(&total).Error; err != nil {
		return 0, err
	}
	return total, nil
}
