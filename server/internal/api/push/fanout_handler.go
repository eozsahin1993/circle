package push

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"

	"circle-relay/internal/httputil"
)

type fanoutRequest struct {
	RoutingIDs []string `json:"routingIds"`
	// Base64. Proves the sender holds the circle's content key, without
	// naming the circle or the sender.
	FanoutToken string `json:"fanoutToken"`
	Category    int64  `json:"category"`
	// Base64 ciphertext plus the fixed placeholder. Forwarded untouched.
	Payload string `json:"payload"`
}

// Totals only — see FanoutResult. Push is best-effort and unacknowledged,
// so a caller has no use for per-target detail anyway.
type fanoutResponse struct {
	Delivered int `json:"delivered"`
	Skipped   int `json:"skipped"`
}

// FanoutHandler is the one unauthenticated route on the relay, and that is
// deliberate. An authenticated send arrives beside an identified poster,
// and a few posts from different members let the relay solve a circle's
// membership by elimination — each poster's own routing id is missing from
// their own fanout. Authorization comes from the fanout token instead.
type FanoutHandler struct {
	Service *Service
	// Nil until the platform credentials exist. Split out so tests can run
	// the resolution path without APNs or FCM.
	Dispatch func(delivery Delivery, payload []byte)
}

func (h *FanoutHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req fanoutRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	fanoutToken, err := base64.StdEncoding.DecodeString(req.FanoutToken)
	if err != nil || len(fanoutToken) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "fanoutToken must be non-empty base64")
		return
	}
	payload, err := base64.StdEncoding.DecodeString(req.Payload)
	if err != nil || len(payload) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "payload must be non-empty base64")
		return
	}
	if len(req.RoutingIDs) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "routingIds is required")
		return
	}

	result, err := h.Service.Fanout(r.Context(), req.RoutingIDs, fanoutToken, req.Category)
	if errors.Is(err, ErrTooManyTargets) {
		httputil.WriteError(w, http.StatusBadRequest, "too many routingIds")
		return
	}
	if err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to fan out")
		return
	}

	for _, delivery := range result.Deliveries {
		h.Dispatch(delivery, payload)
	}

	httputil.WriteJSON(w, http.StatusOK, fanoutResponse{Delivered: len(result.Deliveries), Skipped: result.Skipped})
}
