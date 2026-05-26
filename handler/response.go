package handler

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/basketikun/infinite-canvas/model"
)

type response struct {
	Code int    `json:"code"`
	Data any    `json:"data"`
	Msg  string `json:"msg"`
}

func OK(w http.ResponseWriter, data any) {
	writeJSON(w, response{Code: 0, Data: data, Msg: "ok"})
}

func Fail(w http.ResponseWriter, msg string) {
	writeJSON(w, response{Code: 1, Data: nil, Msg: msg})
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func parseQuery(r *http.Request) model.Query {
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	pageSize, _ := strconv.Atoi(q.Get("pageSize"))
	return model.Query{
		Keyword:    q.Get("keyword"),
		Tags:       q["tag"],
		Category:   q.Get("category"),
		Type:       q.Get("type"),
		Visibility: q.Get("visibility"),
		Page:       page,
		PageSize:   pageSize,
	}
}
