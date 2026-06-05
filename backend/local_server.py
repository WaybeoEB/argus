"""Minimal HTTP server that emulates API Gateway invoking the Lambda handler."""
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json
import logging
import app

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')

class Handler(BaseHTTPRequestHandler):
    def _handle(self, method):
        parsed = urlparse(self.path)
        body = None
        if cl := int(self.headers.get('Content-Length', 0)):
            body = self.rfile.read(cl).decode()
        qs = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        # Strip /api prefix so the Lambda handler sees /queues/...
        path = parsed.path.removeprefix('/api')
        event = {
            'httpMethod': method,
            'path': path,
            'queryStringParameters': qs or None,
            'body': body,
            'headers': {k: v for k, v in self.headers.items()},
        }
        result = app.lambda_handler(event, None)
        self.send_response(result['statusCode'])
        for k, v in result.get('headers', {}).items():
            self.send_header(k, v)
        self.end_headers()
        if result.get('body'):
            self.wfile.write(result['body'].encode())

    def do_GET(self):    self._handle('GET')
    def do_POST(self):   self._handle('POST')
    def do_PUT(self):    self._handle('PUT')
    def do_DELETE(self): self._handle('DELETE')
    def do_OPTIONS(self): self._handle('OPTIONS')

if __name__ == '__main__':
    print('Backend running on http://0.0.0.0:3001')
    HTTPServer(('0.0.0.0', 3001), Handler).serve_forever()
