package integration_test

import "testing"

// assertEqual fails unless actual matches expected. msg, if given, labels
// the failure. t stays an explicit first argument — Go has no ambient
// test context, and a generic method isn't legal Go — same as every
// assertion library's.
func assertEqual[T comparable](t *testing.T, actual, expected T, msg ...string) {
	t.Helper()
	if actual != expected {
		if len(msg) > 0 {
			t.Fatalf("%s: got %v, want %v", msg[0], actual, expected)
		}
		t.Fatalf("got %v, want %v", actual, expected)
	}
}

// assertTrue fails when cond is false, saying what should have held. For
// the claims that aren't a comparison.
func assertTrue(t *testing.T, cond bool, format string, args ...any) {
	t.Helper()
	if !cond {
		t.Fatalf(format, args...)
	}
}
