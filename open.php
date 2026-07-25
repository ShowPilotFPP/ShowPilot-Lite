<?php
// ============================================================
// ShowPilot-Lite — "Open" redirect page
// ============================================================
// FPP's plugin manager (10.x beta+, July 2026) discovers a plugin's
// "Open" button URL by statically scanning menu.inc for a literal,
// quoted page= value ending in .php — it does NOT execute menu.inc's
// PHP to see the real target the way FPP's own nav sidebar does.
//
// Lite's real admin UI lives on a separate Node process (port 3100)
// whose base URL depends on the browser's host, which can only be
// computed at request time, not at static-scan time. So menu.inc
// points at this small real .php file (which the scanner CAN find),
// and this file does the host-based redirect when actually visited.
//
// Keep this in sync with the host-detection logic in menu.inc.
$host = $_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_ADDR'] ?? 'localhost';
$hostNoPort = preg_replace('/:\d+$/', '', $host);
header('Location: http://' . $hostNoPort . ':3100/');
exit;
