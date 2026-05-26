package service

import (
	"errors"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

const (
	promptMaxTitleLen     = 30
	promptMaxTagLen       = 6
	promptMaxTagsCount    = 8
	promptSubmitMaxLength = 4000
)

// ListPrompts 列表查询。前台调用时 q.Visibility 应设为 "public-only"，
// admin 后台传具体 visibility 值（pending/public/rejected）做筛选。
func ListPrompts(q model.Query) (model.PromptList, error) {
	items, total, err := repository.ListPrompts(q)
	if err != nil {
		return model.PromptList{}, err
	}
	tags, err := repository.ListPromptTags(q)
	if err != nil {
		return model.PromptList{}, err
	}
	categories := promptCategoryCodes(ListPromptCategories())
	return model.PromptList{Items: items, Tags: tags, Categories: categories, Total: int(total)}, nil
}

// SubmitPrompt 普通用户从生图记录提交一条提示词到审核队列。
// 校验 title/tags/coverImageId 合法性，coverImageId 必须是当前用户拥有的图片。
func SubmitPrompt(userID string, title string, prompt string, category string, tags []string, coverImageID string) (model.Prompt, error) {
	if userID == "" {
		return model.Prompt{}, errors.New("请先登录")
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return model.Prompt{}, errors.New("标题不能为空")
	}
	if len([]rune(title)) > promptMaxTitleLen {
		return model.Prompt{}, errors.New("标题最多 30 个字")
	}
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return model.Prompt{}, errors.New("提示词内容不能为空")
	}
	if len(prompt) > promptSubmitMaxLength {
		return model.Prompt{}, errors.New("提示词过长，请精简到 4000 字以内")
	}
	cleanTags := make([]string, 0, len(tags))
	for _, tag := range tags {
		t := strings.TrimSpace(tag)
		if t == "" {
			continue
		}
		if len([]rune(t)) > promptMaxTagLen {
			return model.Prompt{}, errors.New("每个标签最多 6 个字")
		}
		cleanTags = append(cleanTags, t)
	}
	if len(cleanTags) > promptMaxTagsCount {
		return model.Prompt{}, errors.New("标签最多 8 个")
	}
	category = strings.TrimSpace(category)
	if category == "" {
		category = "system"
	}
	coverImageID = strings.TrimSpace(coverImageID)
	if coverImageID == "" {
		return model.Prompt{}, errors.New("请选择一张效果图")
	}
	if _, err := GetImageForOwner(userID, coverImageID); err != nil {
		return model.Prompt{}, err
	}

	now := time.Now().Format(time.RFC3339)
	item := model.Prompt{
		ID:          newID("prompt-submit"),
		Title:       title,
		Prompt:      prompt,
		Category:    category,
		Tags:        cleanTags,
		CoverURL:    "/api/images/" + coverImageID,
		Visibility:  model.PromptVisibilityPending,
		SubmitterID: userID,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	return repository.SavePrompt(item)
}

// ReviewPrompt 管理员审核：通过 -> public，拒绝 -> rejected。
func ReviewPrompt(id string, approve bool) error {
	saved, ok, err := repository.GetPromptByID(id)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("提示词不存在")
	}
	if approve {
		saved.Visibility = model.PromptVisibilityPublic
	} else {
		saved.Visibility = model.PromptVisibilityRejected
	}
	saved.UpdatedAt = time.Now().Format(time.RFC3339)
	_, err = repository.SavePrompt(saved)
	return err
}

func ListPromptCategories() []model.PromptCategory {
	categories, _ := repository.ListPromptCategories()
	return categories
}

func SavePrompt(item model.Prompt) (model.Prompt, error) {
	now := time.Now().Format(time.RFC3339)
	if item.Category == "" {
		item.Category = repository.PromptCategories()[0].Category
	}
	if item.ID == "" {
		item.ID = newID(item.Category)
		item.CreatedAt = now
	}
	item.UpdatedAt = now
	category, ok := repository.PromptCategoryByCode(item.Category)
	if !ok {
		category = repository.PromptCategories()[0]
		item.Category = category.Category
	}
	item.GithubURL = ""
	return repository.SavePrompt(item)
}

func DeletePrompt(id string) error {
	return repository.DeletePrompt(id)
}

func promptCategoryCodes(items []model.PromptCategory) []string {
	codes := []string{}
	for _, item := range items {
		if item.Category != "" {
			codes = append(codes, item.Category)
		}
	}
	return codes
}
