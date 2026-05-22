'use strict';
const http = require('node:http');
function createFixtureServer() {
  return http.createServer((req, res) => {
    if (req.url === '/api/data') return res.end(JSON.stringify({ ok: true, value: 42 }));
    if (req.url === '/download.txt') { res.setHeader('content-disposition', 'attachment; filename="download.txt"'); return res.end('fixture download'); }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>Browser Control Fixture</title><h1>Fixture</h1><form id="form"><input id="email" name="email"><select id="role"><option value="user">User</option><option value="admin">Admin</option></select><label><input id="enabled" type="checkbox"> Enabled</label><button id="submit">Submit</button></form><div id="spa"></div><script>setTimeout(()=>{document.getElementById('spa').textContent='SPA ready'},50); document.getElementById('form').addEventListener('submit', e=>{e.preventDefault(); document.body.dataset.submitted='yes';});</script>`);
  });
}
module.exports = { createFixtureServer };
