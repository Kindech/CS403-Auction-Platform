package db

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"auction/backend/internal/models"
	"auction/backend/migrations"
)

func TestErrorClassification(t *testing.T) {
	fk := &pgconn.PgError{Code: "23503", ConstraintName: "bids_item_id_fkey"}
	cases := []struct {
		name                    string
		err                     error
		permanent, item, unique bool
	}{
		{"missing item", fmt.Errorf("wrapped: %w", fk), true, true, false},
		{"numeric overflow", &pgconn.PgError{Code: "22003"}, true, false, false},
		{"duplicate email", &pgconn.PgError{Code: "23505"}, true, false, true},
		{"too many clients", &pgconn.PgError{Code: "53300"}, false, false, false},
		{"connection refused", errors.New("dial tcp: connection refused"), false, false, false},
		{"no error", nil, false, false, false},
	}
	for _, c := range cases {
		if got := IsPermanent(c.err); got != c.permanent {
			t.Errorf("%s: IsPermanent = %v", c.name, got)
		}
		if got := IsMissingItem(c.err); got != c.item {
			t.Errorf("%s: IsMissingItem = %v", c.name, got)
		}
		if got := IsUniqueViolation(c.err); got != c.unique {
			t.Errorf("%s: IsUniqueViolation = %v", c.name, got)
		}
	}
}

// testPool connects to the Postgres in TEST_POSTGRES_URL, or skips: everything
// below needs a real database (CI provides one).
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("TEST_POSTGRES_URL")
	if url == "" {
		t.Skip("TEST_POSTGRES_URL not set")
	}
	ctx := context.Background()
	pool, err := Connect(ctx, url, 20)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := Migrate(ctx, pool, migrations.FS); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return pool
}

func testUser(t *testing.T, pool *pgxpool.Pool) models.User {
	t.Helper()
	u, err := CreateUser(context.Background(), pool, fmt.Sprintf("%s@test.local", models.NewUUID()), "x", "Test User")
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	return u
}

func TestClaimLoginAttempt_ConcurrentAttemptsCannotPassTheLimit(t *testing.T) {
	pool := testPool(t)
	u := testUser(t, pool)
	const maxAttempts, parallel = 5, 40

	var mu sync.Mutex
	var wg sync.WaitGroup
	allowedCount, lockedCount := 0, 0
	for range parallel {
		wg.Add(1)
		go func() {
			defer wg.Done()
			allowed, justLocked, err := ClaimLoginAttempt(context.Background(), pool, u.ID, maxAttempts, time.Minute)
			if err != nil {
				t.Errorf("claim: %v", err)
			}
			mu.Lock()
			defer mu.Unlock()
			if allowed {
				allowedCount++
			}
			if justLocked {
				lockedCount++
			}
		}()
	}
	wg.Wait()
	if allowedCount != maxAttempts || lockedCount != 1 {
		t.Fatalf("%d parallel attempts: %d allowed (want %d), %d triggered the lock (want 1)", parallel, allowedCount, maxAttempts, lockedCount)
	}
}

func TestClaimLoginAttempt_ResetAndExpiry(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	u := testUser(t, pool)

	claim := func(lockout time.Duration) (bool, bool) {
		t.Helper()
		allowed, justLocked, err := ClaimLoginAttempt(ctx, pool, u.ID, 2, lockout)
		if err != nil {
			t.Fatalf("claim: %v", err)
		}
		return allowed, justLocked
	}

	if allowed, justLocked := claim(time.Minute); !allowed || justLocked {
		t.Fatalf("1st of 2: allowed=%v justLocked=%v", allowed, justLocked)
	}
	if err := ResetFailedLogins(ctx, pool, u.ID); err != nil {
		t.Fatal(err)
	}
	claim(time.Minute)
	if allowed, justLocked := claim(time.Millisecond); !allowed || !justLocked {
		t.Fatalf("2nd of 2 after a reset: allowed=%v justLocked=%v", allowed, justLocked)
	}
	time.Sleep(50 * time.Millisecond)
	if allowed, justLocked := claim(time.Minute); !allowed || justLocked {
		t.Fatalf("after the lock expired: allowed=%v justLocked=%v", allowed, justLocked)
	}
}

func TestBatchInsertBids_MissingItemIsPermanent(t *testing.T) {
	pool := testPool(t)
	u := testUser(t, pool)
	err := BatchInsertBids(context.Background(), pool, []BidInsert{{
		RequestID: models.NewUUID(), ItemID: models.NewUUID(), UserID: u.ID,
		Amount: 100, Status: models.BidAccepted, At: time.Now(), AuditDetails: "test",
	}})
	if !IsPermanent(err) || !IsMissingItem(err) {
		t.Fatalf("want a permanent missing-item error, got %v", err)
	}
}
