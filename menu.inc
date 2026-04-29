<?php
# ============================================================
# ShowPilot-Lite — FPP menu integration
# ============================================================
# Adds a single entry to FPP's "Content Setup" menu that opens the
# ShowPilot-Lite admin UI in a new tab. The URL is built dynamically
# from the host the user is browsing FPP from, so it works whether
# they're on the LAN, going through a reverse proxy, or hitting the
# Pi by hostname.
#
# Lite runs on port 3100. The link uses HTTP (Lite doesn't terminate
# TLS itself); put a reverse proxy in front if you need HTTPS.
# ============================================================

# Build the URL using the host the browser used to reach FPP. This
# avoids hard-coding "192.168.x.x" or "fpp.local" — whatever resolves
# for the user's browser will resolve here too.
$host = $_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_ADDR'] ?? 'localhost';
# Strip any :port suffix so we can substitute Lite's port (3100).
$hostNoPort = preg_replace('/:\d+$/', '', $host);
$showpilotUrl = 'http://' . $hostNoPort . ':3100/';

$menuEntries = Array(
    Array(
        'text' => 'ShowPilot-Lite',
        'type' => 'content',
        'page' => $showpilotUrl,
        'wrap' => 0
    )
);
