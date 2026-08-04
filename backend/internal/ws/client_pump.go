package ws

import (
	"log"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
)

// writePump drains c.Send to the socket and keeps the connection alive with
// periodic pings. Must run in its own goroutine; exits (and closes the
// conn) when Send is closed by Hub.Unregister.
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.Conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

type inboundBid struct {
	Type   string  `json:"type"`
	Amount float64 `json:"amount"`
}

// readPump is driven by handler.go's readLoop via ReadOne; this file only
// hosts the always-running keepalive plumbing shared by every connection.
func (c *Client) configureKeepalive() {
	c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
}

func logClose(userID, itemID string, err error) {
	if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
		log.Printf("ws: unexpected close user=%s item=%s err=%v", userID, itemID, err)
	}
}
