// Package kafkabus wraps segmentio/kafka-go for the "bid-requests" topic.
// Messages are keyed by item_id so Kafka's partition assignment guarantees
// strict per-item ordering, which is the core correctness property the
// decoupled architecture depends on.
package kafkabus

import (
	"context"
	"encoding/json"
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
	})
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
