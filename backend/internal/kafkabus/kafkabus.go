// Package kafkabus wraps segmentio/kafka-go for the "bid-requests" topic.
// Messages are keyed by item_id so Kafka's partition assignment guarantees
// strict per-item ordering, which is the core correctness property the
// decoupled architecture depends on.
package kafkabus

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	kafka "github.com/segmentio/kafka-go"

	"auction/backend/internal/models"
)

type Producer struct {
	writer *kafka.Writer
}

func NewProducer(brokers []string, topic string) *Producer {
	return &Producer{
		writer: &kafka.Writer{
			Addr:         kafka.TCP(brokers...),
			Topic:        topic,
			Balancer:     &kafka.Hash{}, // same key -> same partition, always
			RequiredAcks: kafka.RequireOne,
			BatchTimeout: 10 * time.Millisecond,
		},
	}
}

func (p *Producer) PublishBid(ctx context.Context, req models.BidRequest) error {
	payload, err := json.Marshal(req)
	if err != nil {
		return err
	}
	return p.writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(req.ItemID),
		Value: payload,
		Time:  req.Timestamp, // what the broker's BidExpiry check measures from
	})
}

// PublishItemClose writes an item's close marker. Same key as the item's bids,
// so same partition: it is read back after every bid already queued for it.
func (p *Producer) PublishItemClose(ctx context.Context, itemID string) error {
	now := time.Now()
	payload, err := json.Marshal(models.BidRequest{Kind: models.KindItemClose, ItemID: itemID, Timestamp: now})
	if err != nil {
		return err
	}
	return p.writer.WriteMessages(ctx, kafka.Message{Key: []byte(itemID), Value: payload, Time: now})
}

// EnsureBidExpiry makes the broker refuse any bid that reaches it more than
// maxAge after it was placed (record timestamp = BidRequest.Timestamp), via
// the topic's message.timestamp.before.max.ms. kafka-go's Writer keeps
// retrying a write after its caller gave up, so without this a bid whose
// bidder was told "service_unavailable" could be appended - and win - once a
// restarting broker came back. The broker's own clock decides, so a refused
// write is never stored and bid-worker never sees it. Idempotent; called by
// every api-server on startup so existing topics get it too.
func EnsureBidExpiry(ctx context.Context, brokers []string, topic string, maxAge time.Duration) error {
	client := &kafka.Client{Addr: kafka.TCP(brokers...)}
	res, err := client.IncrementalAlterConfigs(ctx, &kafka.IncrementalAlterConfigsRequest{
		Resources: []kafka.IncrementalAlterConfigsRequestResource{{
			ResourceType: kafka.ResourceTypeTopic,
			ResourceName: topic,
			Configs: []kafka.IncrementalAlterConfigsRequestConfig{{
				Name:            "message.timestamp.before.max.ms",
				Value:           strconv.FormatInt(maxAge.Milliseconds(), 10),
				ConfigOperation: kafka.ConfigOperationSet,
			}},
		}},
	})
	if err != nil {
		return err
	}
	for _, r := range res.Resources {
		if r.Error != nil {
			return r.Error
		}
	}
	return nil
}

func (p *Producer) Close() error {
	return p.writer.Close()
}

type Consumer struct {
	reader *kafka.Reader
}

func NewConsumer(brokers []string, topic, groupID string) *Consumer {
	return &Consumer{
		reader: kafka.NewReader(kafka.ReaderConfig{
			Brokers:  brokers,
			Topic:    topic,
			GroupID:  groupID,
			MinBytes: 1,
			MaxBytes: 10e6,
			// After a broker restart (or a bid-worker that died without
			// leaving the group) Kafka holds the partitions for the old
			// member until its session expires - with the 30s default, no
			// bid was adjudicated for ~25s after Kafka was back (TC-10).
			// Heartbeats (every 3s) keep a live worker well inside this.
			SessionTimeout:   10 * time.Second,
			RebalanceTimeout: 10 * time.Second,
		}),
	}
}

// ReadBid blocks until the next message is available. Because this reader
// uses a single consumer-group member, kafka-go delivers messages to this
// one goroutine strictly in the order each assigned partition produced them
// - which is exactly the "1 partition worth of work : 1 worker" invariant
// the architecture relies on to avoid distributed locks.
func (c *Consumer) ReadBid(ctx context.Context) (models.BidRequest, kafka.Message, error) {
	msg, err := c.reader.FetchMessage(ctx)
	if err != nil {
		return models.BidRequest{}, msg, err
	}
	var req models.BidRequest
	if err := json.Unmarshal(msg.Value, &req); err != nil {
		return models.BidRequest{}, msg, err
	}
	return req, msg, nil
}

// CommitOffset acknowledges a message. Call this ONLY after the
// corresponding audit row has been durably written to Postgres, so a worker
// crash between consume and commit results in a safe re-delivery (replay),
// never silent data loss.
func (c *Consumer) CommitOffset(ctx context.Context, msgs ...kafka.Message) error {
	return c.reader.CommitMessages(ctx, msgs...)
}

func (c *Consumer) Close() error {
	return c.reader.Close()
}
