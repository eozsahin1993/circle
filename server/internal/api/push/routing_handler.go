package push

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"

	"circle-relay/internal/httputil"
	"circle-relay/internal/storage/pushstore"
)

// MaxPushTokenBytes leaves room for an FCM registration token plus AEAD
// overhead, while keeping the row from becoming somewhere to park data.
const MaxPushTokenBytes = 4096

type putPrefsRequest struct {
	// Base64 sha256(fanoutToken || routingId), computed client-side. The
	// relay never holds the token itself.
	FanoutHash string `json:"fanoutHash"`
	// A list, not the bitmask it becomes: encoding the mask client-side
	// would pin the storage format into the wire contract.
	Categories []int64 `json:"categories"`
	KeyVersion int64   `json:"keyVersion"`
}

// MaxCategory is what the storage encoding fits. Nothing here knows what
// any category means.
const MaxCategory = 62

// packCategories folds the wire list into the mask the store keeps.
func packCategories(categories []int64) (int64, error) {
	var mask int64
	for _, category := range categories {
		if category < 0 || category > MaxCategory {
			return 0, fmt.Errorf("category %d out of range", category)
		}
		mask |= 1 << uint(category)
	}
	return mask, nil
}

type okResponse struct {
	OK bool `json:"ok"`
}

type PutPrefsHandler struct {
	Service *Service
}

func (h *PutPrefsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	routingID := r.PathValue("routingId")

	var req putPrefsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	fanoutHash, err := base64.StdEncoding.DecodeString(req.FanoutHash)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "fanoutHash must be base64-encoded")
		return
	}
	// Exactly sha256's width: a short hash still compares equal to itself,
	// so a one-byte "hash" would be forgeable by guessing a byte.
	if len(fanoutHash) != 32 {
		httputil.WriteError(w, http.StatusBadRequest, "fanoutHash must be 32 bytes")
		return
	}
	categoryMask, err := packCategories(req.Categories)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	prefs := pushstore.Prefs{FanoutHash: fanoutHash, CategoryMask: categoryMask, KeyVersion: req.KeyVersion}
	if err := h.Service.PutPrefs(r.Context(), routingID, prefs); err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to store push preferences")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, okResponse{OK: true})
}

type putDeviceRequest struct {
	// Base64, already encrypted client-side.
	PushToken string `json:"pushToken"`
	Platform  string `json:"platform"`
	Enabled   bool   `json:"enabled"`
}

type PutDeviceHandler struct {
	Service *Service
}

func (h *PutDeviceHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	routingID := r.PathValue("routingId")
	deviceID := r.PathValue("deviceId")

	var req putDeviceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	pushToken, err := base64.StdEncoding.DecodeString(req.PushToken)
	if err != nil {
		httputil.WriteError(w, http.StatusBadRequest, "pushToken must be base64-encoded")
		return
	}
	if len(pushToken) == 0 {
		httputil.WriteError(w, http.StatusBadRequest, "pushToken is required")
		return
	}
	if len(pushToken) > MaxPushTokenBytes {
		httputil.WriteError(w, http.StatusBadRequest, "pushToken is too large")
		return
	}
	if req.Platform != "ios" && req.Platform != "android" {
		httputil.WriteError(w, http.StatusBadRequest, "platform must be ios or android")
		return
	}

	device := pushstore.Device{
		DeviceID:  deviceID,
		PushToken: pushToken,
		Platform:  req.Platform,
		Enabled:   req.Enabled,
	}
	if err := h.Service.PutDevice(r.Context(), routingID, device); err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to store push device")
		return
	}

	httputil.WriteJSON(w, http.StatusOK, okResponse{OK: true})
}

type DeleteDeviceHandler struct {
	Service *Service
}

func (h *DeleteDeviceHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if err := h.Service.DeleteDevice(r.Context(), r.PathValue("routingId"), r.PathValue("deviceId")); err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to remove push device")
		return
	}
	httputil.WriteJSON(w, http.StatusOK, okResponse{OK: true})
}

// DeleteRoutingHandler silences a circle outright. Idempotent.
type DeleteRoutingHandler struct {
	Service *Service
}

func (h *DeleteRoutingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if err := h.Service.DeleteRouting(r.Context(), r.PathValue("routingId")); err != nil {
		httputil.WriteError(w, http.StatusInternalServerError, "failed to remove push routing")
		return
	}
	httputil.WriteJSON(w, http.StatusOK, okResponse{OK: true})
}
