package getuploadtarget

import (
	"net/http"

	"circle-relay/internal/api/circleerrors"
	"circle-relay/internal/httputil"
)

type response struct {
	URL    string            `json:"url"`
	Fields map[string]string `json:"fields"`
}

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
	writeToken := r.URL.Query().Get("writeToken")
	if writeToken == "" {
		httputil.WriteError(w, http.StatusBadRequest, "writeToken is required")
		return
	}

	target, err := h.Service.UploadTarget(r.Context(), syncID, entryID, writeToken)
	if err != nil {
		status, message := circleerrors.Status(err) // covers both a logstore write-token rejection and blobstore.ErrBlobAlreadyExists
		httputil.WriteError(w, status, message)
		return
	}

	httputil.WriteJSON(w, http.StatusOK, response{URL: target.URL, Fields: target.Fields})
}
