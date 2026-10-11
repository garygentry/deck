"""A deck remote provider (protocol v1) for a NUT-managed UPS: python3 nut_ups.py.

Reads `upsc $NUT_UPS` and serves GET /deck/v1/describe and GET /deck/v1/data on $PORT.
With $SIDECAR_TOKEN set, both require `Authorization: Bearer <token>`. Stdlib only.
"""
import datetime, hmac, json, os, subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPS, TOKEN = os.environ.get("NUT_UPS", "ups@localhost"), os.environ.get("SIDECAR_TOKEN", "")
NUMBERS = {"ups.load": "load", "battery.charge": "charge", "battery.runtime": "runtime", "input.voltage": "inputVoltage"}
TEXT = {"ups.status": "status", "device.model": "model"}
DESCRIBE = {"deck": 1, "id": os.environ.get("SIDECAR_ID", "ups"), "version": "1.0.0", "title": "UPS", "columns": 2,
    "widgets": [
        {"id": "status", "type": "core/stat", "title": "Status", "select": "status"},
        {"id": "runtime", "type": "core/stat", "title": "Runtime", "select": "runtime", "options": {"format": "duration"}},
        {"id": "load", "type": "core/meter", "title": "Load", "select": "load", "options": {"max": 100, "unit": "%"}},
        {"id": "charge", "type": "core/meter", "title": "Battery", "select": "charge", "options": {"max": 100, "unit": "%"}},
        {"id": "details", "type": "core/key-value", "title": "Details", "span": 2,
         "options": {"items": [{"field": "model", "label": "Model"}, {"field": "inputVoltage", "label": "Input", "unit": "V"}]}}],
    "links": [{"title": "NUT documentation", "href": "https://networkupstools.org/docs/user-manual.chunked/"}]}

def read_ups():
    """`upsc` prints `key: value` lines; keep the ones the widgets show."""
    out = subprocess.run(["upsc", UPS], capture_output=True, text=True, timeout=5, check=True).stdout
    data = {}
    for line in out.splitlines():
        key, _, value = line.partition(": ")
        if key in NUMBERS:
            data[NUMBERS[key]] = float(value)
        elif key in TEXT:
            data[TEXT[key]] = value.strip()
    return data

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if TOKEN and not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {TOKEN}"):
            return self.reply(401, {"error": "unauthorised"})
        if self.path == "/deck/v1/describe":
            return self.reply(200, DESCRIBE)
        if self.path != "/deck/v1/data":
            return self.reply(404, {"error": "not found"})
        try:
            data = read_ups()
        except (OSError, ValueError, subprocess.SubprocessError):
            return self.reply(502, {"error": "upsc failed"})
        now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.reply(200, {"data": data, "observedAt": now})

    def reply(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

if __name__ == "__main__":
    server = ThreadingHTTPServer((os.environ.get("BIND", "0.0.0.0"), int(os.environ.get("PORT", "9000"))), Handler)
    print(f"listening on {server.server_address[1]}", flush=True)
    server.serve_forever()
