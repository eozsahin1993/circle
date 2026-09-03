package getuploadtarget

import (
	"encoding/json"
	"net/http"

	"circle-relay/internal/api/circleerrors"
	"circle-relay/internal/httputil"
)

// request carries writeToken in the body rather than a query param — a
// query string commonly ends up in access logs by default (most
// combined/common log formats include the full request line); a POST
// body essentially never does without deliberately opting into full
// request-body capture. Same reasoning as appendlog/rotatelog already
// putting their sensitive fields in the body.
type request struct {
	WriteToken string `json:"writeToken"`
}

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

	var req request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.WriteToken == "" {
		httputil.WriteError(w, http.StatusBadRequest, "writeToken is required")
		return
	}

	target, err := h.Service.UploadTarget(r.Context(), syncID, entryID, req.WriteToken)
	if err != nil {
		status, message := circleerrors.Status(err) // covers both a logstore write-token rejection and blobstore.ErrBlobAlreadyExists
		httputil.WriteError(w, status, message)
		return
	}

	httputil.WriteJSON(w, http.StatusOK, response{URL: target.URL, Fields: target.Fields})
}
