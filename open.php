<?php
// ============================================================
// ShowPilot-Lite — "Open" redirect page (Admin UI)
// ============================================================
// FPP's plugin manager (10.x beta+, July 2026) discovers a plugin's
// "Open" button URL by statically scanning menu.inc for a literal,
// quoted page= value ending in .php — it does NOT execute menu.inc's
// PHP to see the real target. Lite's real admin UI lives on a
// separate Node process (port 3100) whose base URL depends on the
// browser's host, which can only be computed at request time. So
// menu.inc points at this small real .php file, and this file does
// the host-based redirect when actually visited.
//
// IMPORTANT: the Plugin Manager card's "Open" button does NOT reuse
// our &nopage=1 href from menu.inc — FPP's backend
// (_PluginGetBestPageUrl in www/api/controllers/plugin.php) builds
// its own URL from scratch as plugin.php?plugin=X&page=open.php,
// with no nopage param at all. That means plugin.php wraps this file
// in its normal HTML chrome (doctype, head, nav menu, etc.) BEFORE
// including it — so headers are already sent and header('Location:
// ...') fails silently there. The sidebar nav link (which DOES carry
// nopage=1, see menu.inc) hits this file with no prior output, where
// header() works fine. Since we can't control which context a given
// click comes from, this file must work in BOTH: try header() first,
// fall through to a client-side redirect (meta refresh + JS +
// visible link) if headers were already sent.
$host = $_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_ADDR'] ?? 'localhost';
$hostNoPort = preg_replace('/:\d+$/', '', $host);
$target = 'http://' . $hostNoPort . ':3100/admin/';

if (!headers_sent()) {
    header('Location: ' . $target);
    exit;
}
?>
<!DOCTYPE html>
<html>
<head>
<meta http-equiv="refresh" content="0;url=<?php echo htmlspecialchars($target, ENT_QUOTES); ?>">
<script>location.replace(<?php echo json_encode($target); ?>);</script>
</head>
<body>
Redirecting to ShowPilot-Lite Admin&hellip;
<a href="<?php echo htmlspecialchars($target, ENT_QUOTES); ?>"><?php echo htmlspecialchars($target, ENT_QUOTES); ?></a>
</body>
</html>
<?php exit; ?>
