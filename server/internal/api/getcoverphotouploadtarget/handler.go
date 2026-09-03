package getcoverphotouploadtarget

import (
	"encoding/hex"
	"encoding/json"
	"net/http"

	"circle-relay/internal/api/circleerrors"
	"circle-relay/internal/httputil"
)

// request carries every credential in the body, not query params — see
// getuploadtarget's handler.go doc comment for why: a query string
// commonly ends up in access logs by default, a POST body essentially
// never does.
type request struct {
	WriteToken         string `json:"writeToken"`
	AuthorityPublicKey string `json:"authorityPublicKey"`
	Signature          string `json:"signature"`
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

	var req request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	for field, value := range map[string]string{
		"writeToken":         req.WriteToken,
		"authorityPublicKey": req.AuthorityPublicKey,
		"signature":          req.Signature,
	} {
		if value == "" {
			httputil.WriteError(w, http.StatusBadRequest, field+" is required")
			return
		}
	}
	signature, err := hex.DecodeString(req.Signature)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "signature must be hex-encoded")
		return
	}

	target, err := h.Service.UploadTarget(r.Context(), syncID, req.WriteToken, req.AuthorityPublicKey, signature)
	if err != nil {
		status, message := circleerrors.Status(err) // covers a logstore write-token/authority rejection
		httputil.WriteError(w, status, message)
		return
	}

	httputil.WriteJSON(w, http.StatusOK, response{URL: target.URL, Fields: target.Fields})
}
