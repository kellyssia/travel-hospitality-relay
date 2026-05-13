# Travel & Hospitality Relay

Minimal WebSocket broadcast relay for the travel-hospitality audience demo.

- WebSocket endpoint: `wss://<host>/ws`
- Health check: `GET https://<host>/health`

Accepts JSON messages on the WS endpoint, enriches each with a `serverTs` field, and broadcasts to all connected clients including the sender.

## Run locally
