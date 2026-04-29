// ============================================================
// ShowPilot-Lite — Cloudflare Tunnel admin routes (v0.3.0+)
// ============================================================
// Admin-only endpoints to manage a host-level cloudflared service for
// exposing Lite to the public internet. See lib/cloudflared.js for the
// full design rationale.
//
// Mounted at /api/admin/cloudflared. requireAdmin is applied at the
// mount point in server.js, NOT here, to match how /api/admin/backup
// is mounted (consistent middleware ordering for the auth boundary).
// ============================================================

const express = require('express');
const router = express.Router();
const cloudflared = require('../lib/cloudflared');

// Status — read-only, used for both the initial UI render and polling
// while operations are in progress. Cheap enough to call repeatedly.
router.get('/status', async (req, res) => {
  try {
    const status = await cloudflared.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to read tunnel status.' });
  }
});

// Install — downloads + installs the cloudflared deb. Long-running
// (network download + dpkg) so the UI shows a spinner and polls /status.
router.post('/install', async (req, res) => {
  try {
    const r = await cloudflared.install();
    if (!r.ok) return res.status(500).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Install failed.' });
  }
});

// Set token — accepts { token } and registers the service. Idempotent
// in that calling it again with the same token is harmless (we tear
// down + reinstall the unit).
router.post('/token', async (req, res) => {
  const token = req.body && req.body.token;
  try {
    const r = await cloudflared.setToken(token);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Token registration failed.' });
  }
});

router.post('/start', async (req, res) => {
  try {
    const r = await cloudflared.start();
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Start failed.' });
  }
});

router.post('/stop', async (req, res) => {
  try {
    const r = await cloudflared.stop();
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Stop failed.' });
  }
});

router.post('/restart', async (req, res) => {
  try {
    const r = await cloudflared.restart();
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Restart failed.' });
  }
});

router.post('/uninstall', async (req, res) => {
  try {
    const r = await cloudflared.uninstall();
    if (!r.ok) return res.status(500).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Uninstall failed.' });
  }
});

// Logs — last N lines from journalctl for the service. Helpful for
// "my tunnel won't connect" debugging without ssh.
router.get('/logs', async (req, res) => {
  const n = parseInt(req.query.n, 10) || 50;
  try {
    const r = await cloudflared.recentLogs(n);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Log read failed.' });
  }
});

module.exports = router;
