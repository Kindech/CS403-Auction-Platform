// Package migrations embeds the SQL schema files so every binary carries
// them and can apply any that are pending at startup (see db.Migrate).
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
