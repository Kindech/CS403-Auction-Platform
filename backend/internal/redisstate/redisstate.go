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
	return rdb.HSet(ctx, key(st.ItemID), map[string]interface{}{
		"price":         st.Price,
		"bidder_id":     st.BidderID,
		"bidder_name":   st.BidderName,
		"end_time_ms":   st.EndTimeMs,
		"min_increment": st.MinIncrement,
	}).Err()
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

func Set(ctx context.Context, rdb *redis.Client, st models.AuctionState) error {
	return Init(ctx, rdb, st)
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
