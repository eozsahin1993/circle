package dynamodb

import "fmt"

// Single-table design: PK = circleLogId, SK distinguishes item kinds.
// Sort keys share one attribute (DynamoDB requires a uniform type per
// table), so epoch is represented as a zero-padded string to preserve
// numeric ordering lexicographically — the standard trick for mixing
// numeric ordering into a string sort key.
const (
	pkAttr = "pk"
	skAttr = "sk"

	counterSK  = "#counter"
	epochWidth = 12 // supports up to 999,999,999,999 entries per circle — generous past any real use.
)

func epochSK(epoch int64) string {
	return fmt.Sprintf("epoch#%0*d", epochWidth, epoch)
}

// epochSKUpperBound sorts after any real epoch key, for range queries.
func epochSKUpperBound() string {
	max := ""
	for i := 0; i < epochWidth; i++ {
		max += "9"
	}
	return "epoch#" + max
}

func idemSK(entryID string) string {
	return "idem#" + entryID
}
