<?php
# ============================================================
# ShowPilot-Lite — FPP menu integration
# ============================================================
# Adds two entries to FPP's "Content Setup" menu: one to the admin
# UI, one straight to the viewer page. Both are routed through small
# static redirect files (open.php / open-viewer.php — see those files)
# so FPP's plugin-manager "Open" button, which statically scans this
# file for a literal page=....php value rather than executing it, can
# discover a working URL. The Plugin Manager card only ever shows ONE
# Open button, and it always picks the FIRST type="content" entry it
# finds — so Admin is listed first here deliberately. Both entries
# are still reachable individually from the Content Setup dropdown.
#
# This file follows FPP's standard menu.inc convention: define
# $menuEntries, then run the render loop that emits <li><a> HTML
# matching the current $menu (which FPP sets before requiring this
# file once per menu section). Without the render loop, $menuEntries
# is defined but no link is ever printed.
# ============================================================

$menuEntries = Array(
    Array(
        'text' => 'ShowPilot-Lite Admin',
        'type' => 'content',
        'page' => 'open.php',
        'wrap' => 0
    ),
    Array(
        'text' => 'ShowPilot-Lite Viewer Page',
        'type' => 'content',
        'page' => 'open-viewer.php',
        'wrap' => 0
    )
);

##############################################################################
# Render the menu entries that match the current $menu section.
# FPP sets $plugin and $menu before requiring this file.
foreach ($menuEntries as $entry)
{
    if ($entry['type'] != $menu)
        continue;

    $nopage = '';
    if (isset($entry['wrap']) && ($entry['wrap'] == 0))
        $nopage = '&nopage=1';

    // Param order matters: nopage=1 MUST come before page=... . FPP's
    // plugin-manager scanner (10.x beta+, July 2026) extracts page=
    // via a substring regex, not a real query parser — "nopage=1"
    // itself contains the substring "page=1", so if it lands AFTER
    // our real page=open.php the scanner's greedy match grabs "1"
    // instead, breaking the Open button the same way it broke the
    // main ShowPilot plugin. Putting nopage first avoids the collision.
    printf("<li><a href='plugin.php?plugin=%s%s&page=%s'>%s</a></li>\n",
        $plugin, $nopage, $entry['page'], $entry['text']);
}
?>
