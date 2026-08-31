package getblob

import (
	"net/http"
	"strconv"

	"circle-relay/internal/httputil"
)

type Handler struct {
	Service *Service
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	circleLogID := r.PathValue("circleLogId")

	epoch, err := strconv.ParseInt(r.PathValue("epoch"), 10, 64)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "epoch must be an integer")
		return
	}

	url, err := h.Service.DownloadURL(r.Context(), circleLogID, epoch)
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to get blob URL")
		return
	}

	http.Redirect(w, r, url, http.StatusFound)
}
