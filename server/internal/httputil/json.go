// Package httputil holds tiny cross-cutting HTTP plumbing shared across
// endpoint packages — response writing, not business logic. Same category
// as internal/ports/adapters: a shared misc component, not a "domain".
package httputil

import (
	"encoding/json"
	"net/http"
)

func WriteJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func WriteError(w http.ResponseWriter, status int, message string) {
	WriteJSON(w, status, map[string]string{"error": message})
}
