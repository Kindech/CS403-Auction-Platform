package db

import (
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

// IsPermanent reports whether Postgres rejected a statement because of the data
// itself (constraint violation or bad value), so retrying it can never work -
// as opposed to a connection problem, which clears up by itself.
func IsPermanent(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || len(pgErr.Code) < 2 {
		return false
	}
	class := pgErr.Code[:2]
	return class == "22" || class == "23" // data exception, integrity violation
}

// IsMissingItem reports whether a bids insert failed because its item is gone.
func IsMissingItem(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.ConstraintName == "bids_item_id_fkey"
}

// IsUniqueViolation reports whether an insert hit a unique constraint.
func IsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
