package router

import (
	"net/http"

	"github.com/basketikun/infinite-canvas/handler"
	"github.com/basketikun/infinite-canvas/middleware"
	"github.com/gin-gonic/gin"
)

func New() *gin.Engine {
	router := gin.Default()
	router.RedirectTrailingSlash = false
	_ = router.SetTrustedProxies(nil)
	api := router.Group("/api")
	api.GET("/health", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})
	api.POST("/auth/register", gin.WrapF(handler.Register))
	api.POST("/auth/login", gin.WrapF(handler.Login))
	api.GET("/auth/me", middleware.OptionalAuth, gin.WrapF(handler.CurrentUser))
	api.GET("/prompts", middleware.OptionalAuth, gin.WrapF(handler.Prompts))
	api.GET("/assets", middleware.OptionalAuth, gin.WrapF(handler.Assets))

	v1 := api.Group("/v1", middleware.OptionalAuth)
	v1.POST("/images/generations", gin.WrapF(handler.AIImageGenerations))
	v1.POST("/images/edits", gin.WrapF(handler.AIImageEdits))
	v1.POST("/chat/completions", gin.WrapF(handler.AIChatCompletions))
	v1.GET("/models", gin.WrapF(handler.AIModels))

	me := api.Group("", middleware.OptionalAuth)
	me.GET("/user/profile", gin.WrapF(handler.MyProfile))
	me.GET("/user/credit-logs", gin.WrapF(handler.MyCreditLogs))
	me.PUT("/user/preferences", gin.WrapF(handler.UpdateMyPreferences))
	me.GET("/canvases", gin.WrapF(handler.MyCanvases))
	me.POST("/canvases", gin.WrapF(handler.SaveMyCanvas))
	me.GET("/canvases/:id", func(c *gin.Context) {
		handler.GetMyCanvas(c.Writer, c.Request, c.Param("id"))
	})
	me.DELETE("/canvases/:id", func(c *gin.Context) {
		handler.DeleteMyCanvas(c.Writer, c.Request, c.Param("id"))
	})
	me.GET("/generations", gin.WrapF(handler.MyGenerations))
	me.POST("/generations", gin.WrapF(handler.SaveMyGeneration))
	me.DELETE("/generations/:id", func(c *gin.Context) {
		handler.DeleteMyGeneration(c.Writer, c.Request, c.Param("id"))
	})
	me.GET("/assets/me", gin.WrapF(handler.MyAssets))
	me.POST("/assets/me", gin.WrapF(handler.SaveMyAsset))
	me.DELETE("/assets/me/:id", func(c *gin.Context) {
		handler.DeleteMyAsset(c.Writer, c.Request, c.Param("id"))
	})
	me.GET("/agents/me", gin.WrapF(handler.MyAgents))
	me.POST("/agents/me", gin.WrapF(handler.SaveMyAgent))
	me.DELETE("/agents/me/:id", func(c *gin.Context) {
		handler.DeleteMyAgent(c.Writer, c.Request, c.Param("id"))
	})
	me.GET("/pipelines/me", gin.WrapF(handler.MyPipelines))
	me.POST("/pipelines/me", gin.WrapF(handler.SaveMyPipeline))
	me.DELETE("/pipelines/me/:id", func(c *gin.Context) {
		handler.DeleteMyPipeline(c.Writer, c.Request, c.Param("id"))
	})
	me.GET("/pipeline-runs/me", gin.WrapF(handler.MyPipelineRuns))
	me.POST("/pipeline-runs/me", gin.WrapF(handler.CreateMyPipelineRun))
	me.GET("/pipeline-runs/me/:id", func(c *gin.Context) {
		handler.GetMyPipelineRun(c.Writer, c.Request, c.Param("id"))
	})
	me.PUT("/pipeline-runs/me/:id", func(c *gin.Context) {
		handler.SaveMyPipelineRun(c.Writer, c.Request, c.Param("id"))
	})
	me.DELETE("/pipeline-runs/me/:id", func(c *gin.Context) {
		handler.DeleteMyPipelineRun(c.Writer, c.Request, c.Param("id"))
	})
	me.GET("/pipeline-runs/me/:id/zip", func(c *gin.Context) {
		handler.DownloadMyPipelineRunZip(c.Writer, c.Request, c.Param("id"))
	})
	me.POST("/prompts/improve", gin.WrapF(handler.ImprovePrompt))
	me.POST("/prompts/submit", gin.WrapF(handler.SubmitPrompt))
	me.POST("/images", gin.WrapF(handler.UploadImage))
	me.GET("/images/:id", func(c *gin.Context) {
		handler.GetImage(c.Writer, c.Request, c.Param("id"))
	})
	me.DELETE("/images/:id", func(c *gin.Context) {
		handler.DeleteImage(c.Writer, c.Request, c.Param("id"))
	})

	admin := api.Group("/admin", middleware.AdminAuth)
	admin.GET("/users", gin.WrapF(handler.AdminUsers))
	admin.POST("/users", gin.WrapF(handler.AdminSaveUser))
	admin.DELETE("/users/:id", func(c *gin.Context) {
		handler.AdminDeleteUser(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/prompt-categories", gin.WrapF(handler.AdminPromptCategories))
	admin.POST("/prompt-categories/sync", gin.WrapF(handler.AdminSyncPromptCategories))
	admin.GET("/prompts", gin.WrapF(handler.AdminPrompts))
	admin.POST("/prompts", gin.WrapF(handler.AdminSavePrompt))
	admin.DELETE("/prompts/:id", func(c *gin.Context) {
		handler.AdminDeletePrompt(c.Writer, c.Request, c.Param("id"))
	})
	admin.POST("/prompts/:id/review", func(c *gin.Context) {
		handler.AdminReviewPrompt(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/assets", gin.WrapF(handler.AdminAssets))
	admin.POST("/assets", gin.WrapF(handler.AdminSaveAsset))
	admin.DELETE("/assets/:id", func(c *gin.Context) {
		handler.AdminDeleteAsset(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/ai-configs", gin.WrapF(handler.AdminAIConfigs))
	admin.POST("/ai-configs", gin.WrapF(handler.AdminSaveAIConfig))
	admin.POST("/ai-configs/probe-models", gin.WrapF(handler.AdminProbeAIModels))
	admin.DELETE("/ai-configs/:id", func(c *gin.Context) {
		handler.AdminDeleteAIConfig(c.Writer, c.Request, c.Param("id"))
	})
	admin.POST("/ai-configs/:id/enable", func(c *gin.Context) {
		handler.AdminEnableAIConfig(c.Writer, c.Request, c.Param("id"))
	})
	admin.POST("/ai-configs/:id/test", func(c *gin.Context) {
		handler.AdminTestAIConfig(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/generations", gin.WrapF(handler.AdminGenerations))
	admin.GET("/credit-logs", gin.WrapF(handler.AdminCreditLogs))

	router.NoRoute(middleware.NotFoundJSON)

	return router
}
