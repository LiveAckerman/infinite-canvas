package handler

import (
	"io"
	"net/http"
	"strconv"

	"github.com/basketikun/infinite-canvas/service"
)

const uploadFormLimit = 64 << 20

// UploadImage 接收 multipart 字段 "file"，落盘并写元数据，返回 id + 相对 url。
func UploadImage(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	if err := r.ParseMultipartForm(uploadFormLimit); err != nil {
		Fail(w, "请求体解析失败")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		Fail(w, "请上传 file 字段")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		Fail(w, "读取文件失败")
		return
	}
	mime := ""
	if header != nil {
		mime = header.Header.Get("Content-Type")
	}
	saved, err := service.SaveImage(user.ID, data, mime)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, map[string]any{
		"id":       saved.ID,
		"url":      "/api/images/" + saved.ID,
		"mimeType": saved.MimeType,
		"size":     saved.Size,
	})
}

// GetImage 流式返回图片二进制；id 是 uuid 不可枚举，因此走公开访问，方便 <img src> 直链。
// 二进制由 storage 后端（local / r2）提供，handler 无需关心是磁盘还是远程对象。
func GetImage(w http.ResponseWriter, r *http.Request, id string) {
	image, err := service.GetImage(id)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	rc, _, err := service.OpenImageObject(image)
	if err != nil {
		if service.IsImageNotFound(err) {
			Fail(w, "图片文件丢失")
		} else {
			Fail(w, "图片读取失败")
		}
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", image.MimeType)
	// DB 里的 Size 是落盘 / 上传时的字节数，跟实际对象一致。R2 也会带 Content-Length，但 DB 这个稳。
	w.Header().Set("Content-Length", strconv.Itoa(image.Size))
	w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
	_, _ = io.Copy(w, rc)
}

func DeleteImage(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	if err := service.DeleteImage(user.ID, id); err != nil {
		Fail(w, err.Error())
		return
	}
	OK(w, true)
}
