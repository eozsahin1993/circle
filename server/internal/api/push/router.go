package push

import "net/http"

// Register mounts the registration routes. The fanout route is
// deliberately not here — see RegisterFanout.
func Register(mux *http.ServeMux, service *Service) {
	mux.Handle("PUT /push/{routingId}", &PutPrefsHandler{Service: service})
	mux.Handle("DELETE /push/{routingId}", &DeleteRoutingHandler{Service: service})

	mux.Handle("PUT /push/{routingId}/devices/{deviceId}", &PutDeviceHandler{Service: service})
	mux.Handle("DELETE /push/{routingId}/devices/{deviceId}", &DeleteDeviceHandler{Service: service})
}

// RegisterFanout mounts the send route, which authorizes on the fanout
// token rather than a session. Separate from Register so mounting it under
// authentication takes deleting this comment first.
func RegisterFanout(mux *http.ServeMux, handler *FanoutHandler) {
	mux.Handle("POST /push/send", handler)
}
