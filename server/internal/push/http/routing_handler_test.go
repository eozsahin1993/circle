package push

import (
	"testing"

	"mimoza-relay/internal/push"
)

func TestPackCategories(t *testing.T) {
	mask, err := packCategories([]int64{0, 2, 5})
	if err != nil {
		t.Fatal(err)
	}
	if mask != 0b100101 {
		t.Fatalf("expected 0b100101, got %b", mask)
	}

	if _, err := packCategories([]int64{-1}); err == nil {
		t.Fatal("expected a negative category to be rejected")
	}
	if _, err := packCategories([]int64{push.MaxCategory + 1}); err == nil {
		t.Fatal("expected an out-of-range category to be rejected")
	}
}
