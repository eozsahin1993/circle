// Package config is the one place environment-derived settings are read
// from — both cmd/lambda and cmd/server call Load() instead of scattering
// (and duplicating) os.Getenv calls across entry points. Add new fields
// here as the app needs more configuration, rather than reaching for
// os.Getenv anywhere else.
package config

import (
	"log"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	TableName  string
	BucketName string
	// DevicesTableName is the standalone device/session-state table — see
	// server/provision/devices_table.tf. Not circle-scoped, so it's a
	// separate table from TableName, not a shape sharing it.
	DevicesTableName string
	// RootSecretCiphertext is the base64 KMS ciphertext blob for the app's
	// single root secret — see internal/adapters/kms, internal/kdf, and
	// server/provision/kms.tf. Safe as a plain env var: useless without the
	// KMS key that encrypted it.
	RootSecretCiphertext string
	// GoogleClientIDs are the accepted "aud" values for Google Sign-In ID
	// tokens — one per platform (iOS, Android, Web), since native Google
	// Sign-In issues tokens audienced to whichever client ID initiated the
	// flow. Comma-separated in the env var.
	GoogleClientIDs []string
	// AppleClientIDs are the accepted "aud" values for Sign in with Apple
	// ID tokens — typically the app's iOS bundle ID, plus a Services ID if
	// a web/Android flow is ever added. Comma-separated in the env var.
	AppleClientIDs []string
	// LogRetentionDays is passed straight to dynamodb.NewLogStore — see
	// server/DESIGN.md and provision/variables.tf's log_retention_days. 0
	// means "use the adapter's own default". Eviction itself is DynamoDB's
	// native TTL (see provision/modules/storage/dynamodb.tf), not this
	// process — this only controls what expiresAt gets written as.
	LogRetentionDays int64
	// MaxBlobSize is passed straight to s3.NewBlobStore — see
	// server/DESIGN.md and provision/variables.tf's max_blob_size_bytes. 0
	// means "use the adapter's own default".
	MaxBlobSize int64
	// Port is only used by cmd/server (cmd/lambda doesn't listen on a port).
	Port string
	// S3ForcePathStyle is only ever true for local testing against
	// LocalStack, which doesn't resolve virtual-hosted-style bucket
	// subdomains (bucket.host) the way real S3 does. Real AWS always uses
	// the default (false) — never set this in a deployed environment.
	S3ForcePathStyle bool
}

// Load reads every setting from the environment, once, at startup. Fails
// fast (log.Fatalf) on a missing required value or a malformed one —
// cmd/ entries are meant to crash immediately on misconfiguration, not
// limp along with a zero value.
func Load() Config {
	return Config{
		TableName:            mustEnv("TABLE_NAME"),
		BucketName:           mustEnv("BUCKET_NAME"),
		DevicesTableName:     mustEnv("DEVICES_TABLE_NAME"),
		RootSecretCiphertext: mustEnv("ROOT_SECRET_CIPHERTEXT"),
		GoogleClientIDs:      csvEnv("GOOGLE_CLIENT_IDS"),
		AppleClientIDs:       csvEnv("APPLE_CLIENT_IDS"),
		LogRetentionDays:     intEnv("LOG_RETENTION_DAYS", 0),
		MaxBlobSize:          intEnv("MAX_BLOB_SIZE_BYTES", 0),
		Port:                 envOr("PORT", "8080"),
		S3ForcePathStyle:     envOr("S3_FORCE_PATH_STYLE", "false") == "true",
	}
}

func mustEnv(name string) string {
	value := os.Getenv(name)
	if value == "" {
		log.Fatalf("missing required environment variable %s", name)
	}
	return value
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func intEnv(name string, fallback int64) int64 {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		log.Fatalf("%s must be an integer, got %q", name, raw)
	}
	return value
}

// csvEnv splits a required, comma-separated env var into trimmed,
// non-empty values — used for the two client-ID allowlists, which are
// naturally multi-valued (one ID per platform) but still have no sane
// zero-value default.
func csvEnv(name string) []string {
	raw := mustEnv(name)
	parts := strings.Split(raw, ",")
	values := make([]string, 0, len(parts))
	for _, p := range parts {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			values = append(values, trimmed)
		}
	}
	if len(values) == 0 {
		log.Fatalf("%s must contain at least one value", name)
	}
	return values
}
