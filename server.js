const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = 'c:/Users/admin.DESKTOP-L2K21NT/WorkBuddy/20260413174127/doc-renewal';
const PORT = 7788;

const mime = {
  'html': 'text/html; charset=utf-8',
  'css': 'text/css',
  'js': 'text/javascript',
  'json': 'application/json',
  'svg': 'image/svg+xml',
  'png': 'image/png',
  'ico': 'image/x-icon'
};

http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);
  try {
    const data = fs.readFileSync(filePath);
    const ext = filePath.split('.').pop().toLowerCase();
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'text/plain',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(data);
  } catch(e) {
    res.writeHead(404);
    res.end('Not found: ' + urlPath);
  }
}).listen(PORT, () => {
  console.log('Server running on http://localhost:' + PORT);
});
