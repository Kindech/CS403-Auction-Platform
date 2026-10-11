// Package redisstate manages the per-item "current auction state" hash in
// Redis. Reads/writes here are only ever done from bid-worker's single
// sequential consumer loop for a given item, so no distributed lock is
// required: Kafka's per-partition ordering (partitioned by item_id) plus a
// single-threaded consumer already serializes all access to one item's key.
package redisstate

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"auction/backend/internal/models"
)

func key(itemID string) string {
	return "item:" + itemID + ":state"
}

func New(addr string) *redis.Client {
	return redis.NewClient(&redis.Options{Addr: addr})
}

func Init(ctx context.Context, rdb *redis.Client, st models.AuctionState) error {
	return rdb.HSet(ctx, key(st.ItemID), stateFields(st)).Err()
}

func stateFields(st models.AuctionState) map[string]interface{} {
	return map[string]interface{}{
		"price":         st.Price,
		"bidder_id":     st.BidderID,
		"bidder_name":   st.BidderName,
		"end_time_ms":   st.EndTimeMs,
		"min_increment": st.MinIncrement,
	}
}

func Get(ctx context.Context, rdb *redis.Client, itemID string) (models.AuctionState, bool, error) {
	res, err := rdb.HGetAll(ctx, key(itemID)).Result()
	if err != nil {
		return models.AuctionState{}, false, err
	}
	if len(res) == 0 {
		return models.AuctionState{}, false, nil
	}
	st := models.AuctionState{ItemID: itemID, BidderID: res["bidder_id"], BidderName: res["bidder_name"]}
	st.Price, _ = strconv.ParseFloat(res["price"], 64)
	st.MinIncrement, _ = strconv.ParseFloat(res["min_increment"], 64)
	st.EndTimeMs, _ = strconv.ParseInt(res["end_time_ms"], 10, 64)
	return st, true, nil
}

// appliedKey holds the request_ids of bids already accepted into an item's
// state, so a Kafka re-delivery of one can be recognized as such.
func appliedKey(itemID string) string {
	return "item:" + itemID + ":applied"
}

// appliedTTL bounds how long applied request_ids are kept. Delete leaves the
// set alone on purpose: a bid accepted right before a worker crash can be
// replayed after its auction has already been finalized, and must still be
// recognized then. 7 days is far longer than any replay delay.
const appliedTTL = 7 * 24 * time.Hour

// SetAccepted writes the new state for an accepted bid and records its
// request_id as applied, atomically (MULTI/EXEC): a crash can never leave
// the price updated without the bid being marked applied, or vice versa.
func SetAccepted(ctx context.Context, rdb *redis.Client, st models.AuctionState, requestID string) error {
	_, err := rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.HSet(ctx, key(st.ItemID), stateFields(st))
		if requestID != "" {
			p.SAdd(ctx, appliedKey(st.ItemID), requestID)
			p.Expire(ctx, appliedKey(st.ItemID), appliedTTL)
		}
		return nil
	})
	return err
}

// WasApplied reports whether a bid with this request_id was already
// accepted into the item's state - i.e. this delivery is a replay.
func WasApplied(ctx context.Context, rdb *redis.Client, itemID, requestID string) (bool, error) {
	if requestID == "" {
		return false, nil
	}
	return rdb.SIsMember(ctx, appliedKey(itemID), requestID).Result()
}

func Delete(ctx context.Context, rdb *redis.Client, itemID string) error {
	return rdb.Del(ctx, key(itemID)).Err()
}

func Exists(ctx context.Context, rdb *redis.Client, itemID string) (bool, error) {
	n, err := rdb.Exists(ctx, key(itemID)).Result()
	return n > 0, err
}

func ItemIDFromKey(k string) (string, error) {
	// "item:<id>:state" -> <id>
	const prefix = "item:"
	const suffix = ":state"
	if len(k) <= len(prefix)+len(suffix) {
		return "", fmt.Errorf("malformed key %q", k)
	}
	return k[len(prefix) : len(k)-len(suffix)], nil
}
