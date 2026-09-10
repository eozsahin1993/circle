package push

import "crypto/sha256"

// FanoutHash is sha256(fanoutToken || routingId) — stored on the prefs
// row, recomputed on each send.
//
// Salted by routing id because every member of a circle derives the same
// token: a bare hash would write one identical value across that circle's
// rows and cluster its membership straight out of a table scan.
//
// Clients compute this too, so the concatenation order is contract.
func FanoutHash(fanoutToken []byte, routingID string) []byte {
	sum := sha256.New()
	sum.Write(fanoutToken)
	sum.Write([]byte(routingID))
	return sum.Sum(nil)
}
