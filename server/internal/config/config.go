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
	"time"
)

type Config struct {
	TableName  string
	BucketName string
	// SessionsTableName is the standalone bearer-token session table — see
	// server/provision/sessions_table.tf. Not circle-scoped, so it's a
	// separate table from TableName; also separate from AccountsTableName
	// (token-lookup vs account-lookup are different access patterns).
	SessionsTableName string
	// AccountsTableName is the standalone one-document-per-account table
	// (today: the encrypted recovery manifest) — see
	// server/provision/accounts_table.tf.
	AccountsTableName string
	// InviteTableName is the standalone invite/join-request table: pk =
	// hash(invite code), with one row for the invite itself and one row
	// per pending join request under it — see
	// server/provision/modules/storage/dynamodb.tf's invites resource.
	InviteTableName string
	// RateLimitTableName is the standalone per-account request-budget
	// table — see server/provision/rate_limit_table.tf. Shared by the write
	// and read budgets below; ratelimitdynamodb.New's keyPrefix keeps their
	// rows from colliding.
	RateLimitTableName string
	// PushTableName is the standalone push routing table — routing id
	// prefs plus one row per device. Separate from every other table for
	// the same reason the others are: different lifecycle, different
	// access pattern, and nothing joins across them.
	PushTableName string
	// FCMCredentialParameter is the SSM SecureString holding the FCM
	// service-account key. Created by hand, never by Terraform — a
	// Terraform-managed value lands in state as plaintext.
	FCMCredentialParameter string
	// FCMCredentialFile is a local path read instead of SSM — for running
	// the relay against LocalStack. Empty in Lambda.
	FCMCredentialFile string
	// APNSAuthKeyParameter is the SSM SecureString holding the APNs .p8
	// auth key. Same reasoning as FCMCredentialParameter: created by hand,
	// never by Terraform.
	APNSAuthKeyParameter string
	// APNSAuthKeyFile is a local path read instead of SSM — for LocalStack.
	APNSAuthKeyFile string
	// APNSKeyID/APNSTeamID identify the key at Apple. Unlike FCM's JSON
	// blob, the .p8 file carries neither, so they're configured separately.
	APNSKeyID  string
	APNSTeamID string
	// APNSTopic is the apns-topic header value — the app's iOS bundle id.
	APNSTopic string
	// APNSProduction selects api.push.apple.com over the sandbox host.
	// False by default: a debug-signed build only works against sandbox.
	APNSProduction bool
	// RateLimitWriteMaxRequests/RateLimitReadMaxRequests are starting
	// guesses, not measurements — env-tunable so they can be adjusted from
	// real traffic without a redeploy.
	RateLimitWriteMaxRequests int64
	RateLimitReadMaxRequests  int64
	// RateLimitPushMaxRequests budgets how many pushes one recipient
	// routing id may receive per window. Generous on purpose: a lively
	// circle legitimately generates a lot of received notifications, so
	// this bounds the pathological case rather than the merely noisy one.
	RateLimitPushMaxRequests int64
	// RateLimitWindowMinutes is the fixed window both budgets reset on.
	RateLimitWindowMinutes int64
	// GoogleClientIDIOS/Android/Web are the accepted "aud" values for
	// Google Sign-In ID tokens, one per platform client registered in
	// Google Cloud Console — named per-platform (mirroring app/.env.local's
	// EXPO_PUBLIC_GOOGLE_*_CLIENT_ID) rather than one combined list, so a
	// missing platform is an obviously-empty field instead of a silently
	// wrong position in a comma list. Any of these may be empty if that
	// platform isn't in use yet.
	GoogleClientIDIOS     string
	GoogleClientIDAndroid string
	GoogleClientIDWeb     string
	// AppleClientIDIOS is the accepted "aud" value for Sign in with Apple
	// ID tokens — the app's iOS bundle ID. A Services ID would join this
	// as a second named field if a web/Android Apple flow is ever added.
	AppleClientIDIOS string
	// MaxBlobSize is passed straight to s3.NewBlobStore, overriding its
	// DefaultMaxBlobSize — see provision/variables.tf's
	// max_blob_size_bytes. 0 means "use the adapter's own default".
	MaxBlobSize int64
	// InviteRetentionDays is passed straight to invitedynamodb.New — see
	// provision/variables.tf's invite_retention_days. 0 means "use the
	// adapter's own default".
	// Eviction itself is DynamoDB's native TTL
	// (see provision/modules/storage/dynamodb.tf), not this process — this
	// only controls what expiresAt gets written as.
	InviteRetentionDays int64
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
		TableName:                 mustEnv("TABLE_NAME"),
		BucketName:                mustEnv("BUCKET_NAME"),
		SessionsTableName:         mustEnv("SESSIONS_TABLE_NAME"),
		AccountsTableName:         mustEnv("ACCOUNTS_TABLE_NAME"),
		InviteTableName:           mustEnv("INVITE_TABLE_NAME"),
		RateLimitTableName:        mustEnv("RATE_LIMIT_TABLE_NAME"),
		PushTableName:             mustEnv("PUSH_TABLE_NAME"),
		FCMCredentialParameter:    strEnv("FCM_CREDENTIAL_PARAMETER", "/circle/fcm-service-account"),
		FCMCredentialFile:         os.Getenv("FCM_CREDENTIAL_FILE"),
		APNSAuthKeyParameter:      strEnv("APNS_AUTH_KEY_PARAMETER", "/circle/apns-auth-key"),
		APNSAuthKeyFile:           os.Getenv("APNS_AUTH_KEY_FILE"),
		APNSKeyID:                 envOr("APNS_KEY_ID", ""),
		APNSTeamID:                envOr("APNS_TEAM_ID", ""),
		APNSTopic:                 envOr("APNS_TOPIC", ""),
		APNSProduction:            envOr("APNS_PRODUCTION", "false") == "true",
		RateLimitWriteMaxRequests: intEnv("RATE_LIMIT_WRITE_MAX_REQUESTS", 500),
		RateLimitReadMaxRequests:  intEnv("RATE_LIMIT_READ_MAX_REQUESTS", 2000),
		RateLimitPushMaxRequests:  intEnv("RATE_LIMIT_PUSH_MAX_REQUESTS", 500),
		RateLimitWindowMinutes:    intEnv("RATE_LIMIT_WINDOW_MINUTES", 10),
		GoogleClientIDIOS:         envOr("GOOGLE_CLIENT_ID_IOS", ""),
		GoogleClientIDAndroid:     envOr("GOOGLE_CLIENT_ID_ANDROID", ""),
		GoogleClientIDWeb:         envOr("GOOGLE_CLIENT_ID_WEB", ""),
		AppleClientIDIOS:          envOr("APPLE_CLIENT_ID_IOS", ""),
		MaxBlobSize:               intEnv("MAX_BLOB_SIZE_BYTES", 0),
		InviteRetentionDays:       intEnv("INVITE_RETENTION_DAYS", 0),
		Port:                      envOr("PORT", "8080"),
		S3ForcePathStyle:          envOr("S3_FORCE_PATH_STYLE", "false") == "true",
	}
}

// RateLimitWindow is RateLimitWindowMinutes as a time.Duration, for
// passing straight into ratelimitdynamodb.New.
func (c Config) RateLimitWindow() time.Duration {
	return time.Duration(c.RateLimitWindowMinutes) * time.Minute
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

func strEnv(name, fallback string) string {
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
