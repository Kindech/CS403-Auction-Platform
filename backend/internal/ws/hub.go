package ws

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/gorilla/websocket"
)

type Client struct {
	Conn        *websocket.Conn
	Send        chan []byte
	ItemID      string
	UserID      string
	displayName string
}

// Hub fans WS traffic out to every client subscribed to an item's room.
// One Hub instance per api-server process; bid-worker calls every
// api-server's /internal/events so each Hub only needs to know about its
// own locally-connected clients.
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]map[*Client]bool // itemID -> clients
}

func NewHub() *Hub {
	return &Hub{rooms: make(map[string]map[*Client]bool)}
}

func (h *Hub) Register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rooms[c.ItemID] == nil {
		h.rooms[c.ItemID] = make(map[*Client]bool)
	}
	h.rooms[c.ItemID][c] = true
}

func (h *Hub) Unregister(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room, ok := h.rooms[c.ItemID]; ok {
		delete(room, c)
		if len(room) == 0 {
			delete(h.rooms, c.ItemID)
		}
	}
	close(c.Send)
}

func (h *Hub) send(c *Client, payload []byte) {
	select {
	case c.Send <- payload:
	default:
		log.Printf("ws: client send buffer full, dropping message for user=%s item=%s", c.UserID, c.ItemID)
	}
}

// BroadcastToRoom pushes an event to every client currently subscribed to
// the given item (used for accepted bids, extensions, and auction end).
func (h *Hub) BroadcastToRoom(itemID string, ev Event) {
	payload, err := json.Marshal(ev)
	if err != nil {
		log.Printf("ws: marshal event: %v", err)
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.rooms[itemID] {
		h.send(c, payload)
	}
}

// SendToUser pushes an event to the single connection matching itemID+userID
// (used for rejected bids, so we don't waste bandwidth telling everyone else).
func (h *Hub) SendToUser(itemID, userID string, ev Event) {
	payload, err := json.Marshal(ev)
	if err != nil {
		log.Printf("ws: marshal event: %v", err)
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.rooms[itemID] {
		if c.UserID == userID {
			h.send(c, payload)
		}
	}
}

// SendTo delivers an event either to the whole room or to one user,
// depending on whether TargetUserID is set - this is the shape bid-worker
// posts to /internal/events.
func (h *Hub) SendTo(ev Event) {
	if ev.TargetUserID != "" {
		h.SendToUser(ev.ItemID, ev.TargetUserID, ev)
		return
	}
	h.BroadcastToRoom(ev.ItemID, ev)
}
