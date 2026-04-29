<?php
# ============================================================
# ShowPilot-Lite — FPP menu integration
# ============================================================
# Adds a single entry to FPP's "Content Setup" menu that opens the
# ShowPilot-Lite admin UI in a new tab. The URL is built dynamically
# from the host the user is browsing FPP from.
#
# This file follows FPP's standard menu.inc convention: define
# $menuEntries, then run the render loop that emits <li><a> HTML
# matching the current $menu (which FPP sets before requiring this
# file once per menu section). Without the render loop, $menuEntries
# is defined but no link is ever printed.
# ============================================================

# Build the URL using the host the browser used to reach FPP. This
# avoids hard-coding "192.168.x.x" or "fpp.local" — whatever resolves
# for the user's browser will resolve here too. Strip any :port
# suffix so we can substitute Lite's port (3100).
$host = $_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_ADDR'] ?? 'localhost';
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

##############################################################################
# Render the menu entries that match the current $menu section.
# FPP sets $plugin and $menu before requiring this file. http(s)://
# pages emit a plain external link with target=_blank; relative pages
# go through plugin.php for FPP-chrome wrapping.
foreach ($menuEntries as $entry)
{
    if ($entry['type'] != $menu)
        continue;

    if (preg_match('/^http.?:\/\//', $entry['page']))
    {
        printf("<li><a href='%s' target='_blank'>%s</a></li>\n",
            $entry['page'], $entry['text']);
    }
    else
    {
        $nopage = '';
        if (isset($entry['wrap']) && ($entry['wrap'] == 0))
            $nopage = '&nopage=1';

        printf("<li><a href='plugin.php?plugin=%s&page=%s%s'>%s</a></li>\n",
            $plugin, $entry['page'], $nopage, $entry['text']);
    }
}
?>
