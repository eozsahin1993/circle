package getblob

import (
	"net/http"

	"circle-relay/internal/httputil"
)

type Handler struct {
	Service *Service
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	syncID := r.PathValue("syncId")
	entryID := r.PathValue("entryId")
	if entryID == "" {
		httputil.WriteError(w, http.StatusBadRequest, "entryId is required")
		return
	}

	url, err := h.Service.DownloadURL(r.Context(), syncID, entryID)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to get blob URL")
		return
	}

	http.Redirect(w, r, url, http.StatusFound)
}
